import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  type MemoryJobDto,
  type MemoryRequestScope,
  type MemoryRuntimePolicy,
} from '@fateclaw/contracts/memory';
import { isMemoryIsoInstant } from '@fateclaw/contracts/agent/memory';
import { getDbPool, type DbQueryable } from '#infrastructure/db-pool';
import {
  MemoryError,
  isoDate,
  memoryHash,
  type MemoryItemRow,
  type MemoryJobRow,
  type MemoryScopeRow,
} from './domain.js';
import {
  actorSubjectId,
  assertMemorySubject,
  captureMemorySource,
  ensureOwnerMemoryScope,
  getCurrentMemorySource,
  hasOwnerMemoryAudience,
  indexMemoryText,
  insertMemoryItem,
  lockMemoryRoot,
  queueMemoryJob,
  readMemoryRoot,
  memorySpaceId,
  reauthorizeMemorySourceForBackfill,
  withMemoryTransaction,
} from './repository.js';
import { isMemoryPiContextCurrent } from './pi-contexts.js';
import { getMemoryRuntimePolicy } from './policy.js';
import {
  reserveMemoryBudget,
  settleMemoryBudget,
  type MemoryBudgetReservation,
} from './budget.js';
import {
  estimateMemoryExtractionInput,
  extractMemoryCandidates,
  type MemoryExistingFact,
  type MemorySourceInput,
} from './extraction.js';
import {
  MemoryModelError,
  type MemoryModelResolver,
  type MemoryModelResult,
  type MemoryTextRunner,
} from './model-client.js';

type CurrentSource = NonNullable<
  Awaited<ReturnType<typeof getCurrentMemorySource>>
>;

export interface MemoryJobProcessors {
  extract: typeof extractMemoryCandidates;
}

export interface MemoryJobOptions {
  signal?: AbortSignal;
  processors?: Partial<MemoryJobProcessors>;
  modelOptions?: {
    runner?: MemoryTextRunner;
    resolveModel?: MemoryModelResolver;
  };
}

class StaleMemoryJob extends MemoryError {
  constructor(code = 'MEMORY.REVOKED') {
    super('记忆任务的来源、设置或租约已变化。', 409, code);
  }
}

export async function claimMemoryJobs(
  policy: MemoryRuntimePolicy,
  limit = policy.worker_concurrency,
  db: DbQueryable = getDbPool(),
): Promise<MemoryJobRow[]> {
  if (!policy.enabled || limit < 1) return [];
  const { rows } = await db.query<MemoryJobRow>(
    `WITH exhausted AS (
       UPDATE memory_jobs SET state='failed',lease_token=NULL,lease_until=NULL,
         error_code=COALESCE(error_code,'MEMORY.ATTEMPTS_EXHAUSTED'),updated_at=clock_timestamp()
       WHERE attempts>=$1 AND (state='pending' OR state='running' AND lease_until<=clock_timestamp())
     ), candidates AS (
       SELECT id FROM memory_jobs
       WHERE attempts<$1 AND next_attempt_at<=clock_timestamp()
         AND (state='pending' OR state='running' AND lease_until<=clock_timestamp())
       ORDER BY CASE WHEN kind='extract' AND NOT(payload ? 'backfillJobId') THEN 0
         WHEN kind='extract' THEN 1 ELSE 2 END,created_at,id
       FOR UPDATE SKIP LOCKED LIMIT $2
     ) UPDATE memory_jobs j SET state='running',attempts=j.attempts+1,
       lease_token=gen_random_uuid()::text,lease_until=clock_timestamp()+$3::int*interval '1 millisecond',
       error_code=NULL,updated_at=clock_timestamp()
       FROM candidates c WHERE j.id=c.id RETURNING j.*`,
    [
      policy.max_attempts,
      Math.min(limit, policy.worker_concurrency),
      policy.job_timeout_ms + 15_000,
    ],
  );
  return rows;
}

async function assertLease(
  job: MemoryJobRow,
  db: DbQueryable,
  lock = false,
): Promise<MemoryJobRow> {
  const { rows } = await db.query<MemoryJobRow>(
    `SELECT * FROM memory_jobs WHERE id=$1 AND state='running' AND lease_token=$2
       AND lease_until>clock_timestamp() ${lock ? 'FOR UPDATE' : ''}`,
    [job.id, job.lease_token],
  );
  if (!rows[0]) throw new StaleMemoryJob('MEMORY.LEASE_LOST');
  return rows[0];
}

async function jobScope(
  job: MemoryJobRow,
  db: DbQueryable,
  root?: MemoryScopeRow,
  needsLearning = false,
  identity?: MemoryRequestScope,
  namespace?: string | null,
): Promise<MemoryRequestScope> {
  const current = root ?? (await readMemoryRoot(job.scope_id, db));
  if (
    current.owner_user_id !== job.owner_user_id ||
    current.epoch !== job.epoch
  )
    throw new StaleMemoryJob();
  if (needsLearning && !current.learning_enabled)
    throw new StaleMemoryJob('MEMORY.LEARNING_CHANGED');
  const scoped = await db.query<MemoryScopeRow>(
    'SELECT * FROM memory_scopes WHERE id=$1 AND owner_user_id=$2',
    [job.scope_id, job.owner_user_id],
  );
  const row = scoped.rows[0];
  if (!row) throw new StaleMemoryJob();
  if (
    identity &&
    (identity.scopeId !== job.scope_id ||
      identity.ownerUserId !== job.owner_user_id ||
      identity.actorKey !== row.actor_key ||
      identity.audienceKey !== row.audience_key ||
      identity.subjectId !== job.subject_id ||
      identity.epoch !== job.epoch ||
      (needsLearning &&
        (identity.bindingRevision ?? 1) !== (row.binding_revision ?? 1)))
  )
    throw new StaleMemoryJob('MEMORY.BINDING_CHANGED');
  const space = namespace ?? identity?.memorySpaceId ?? row.id;
  if (
    space !== row.id &&
    (space !== current.id || !identity || !hasOwnerMemoryAudience(identity))
  )
    throw new StaleMemoryJob('MEMORY.SPACE_DENIED');
  const scope: MemoryRequestScope = {
    scopeId: row.id,
    ownerUserId: job.owner_user_id,
    actorKey: row.actor_key,
    audienceKey: row.audience_key,
    subjectId: job.subject_id ?? `self:${job.owner_user_id}`,
    epoch: current.epoch,
    learningEnabled: current.learning_enabled,
    recallEnabled: current.recall_enabled,
    chatEditingEnabled: current.chat_editing_enabled,
    contextGeneration: 0,
    memorySpaceId: space,
    speakerSubjectId:
      identity?.speakerSubjectId ??
      (identity
        ? actorSubjectId(identity)
        : (row.bound_subject_id ?? undefined)),
    bindingRevision: identity?.bindingRevision ?? row.binding_revision ?? 1,
    ownerMemoryAccess:
      identity?.ownerMemoryAccess ?? row.share_subject_memory ?? false,
  };
  await assertMemorySubject(scope, scope.subjectId, db);
  return scope;
}

function explicitBackfill(job: MemoryJobRow): boolean {
  return (
    job.event_type === 'explicit_backfill_grant' ||
    (typeof job.payload.backfillJobId === 'string' &&
      job.payload.backfillJobId.length > 0)
  );
}

/** Reads the current per-conversation switch; turning it off also cancels queued work. */
export async function assertAutomaticMemorySourceCurrent(
  job: MemoryJobRow,
  source: CurrentSource,
  db: DbQueryable = getDbPool(),
): Promise<void> {
  if (source.source_kind !== 'message') return;
  const { rows } = await db.query<{ memory_learning_enabled: boolean }>(
    `SELECT memory_learning_enabled FROM chat_sessions
     WHERE id=$1 AND account_id=$2 AND user_id=$3 AND deleted_at IS NULL`,
    [source.session_id, source.account_id, job.owner_user_id],
  );
  const session = rows[0];
  if (!session) throw new StaleMemoryJob('MEMORY.SESSION_MISSING');
  // The host records this authorization when it accepts the explicit history import.
  if (explicitBackfill(job)) return;
  const identity = source.identity_snapshot;
  if (
    !identity ||
    identity.learningEnabled !== true ||
    !session.memory_learning_enabled
  )
    throw new StaleMemoryJob('MEMORY.SESSION_LEARNING_CHANGED');
  if (
    !(await isMemoryPiContextCurrent(
      {
        sessionId: source.session_id!,
        audience: identity.contextAudience ?? '',
        generation: identity.contextGeneration,
      },
      db,
    ))
  )
    throw new StaleMemoryJob('MEMORY.CONTEXT_CHANGED');
}

async function currentSource(
  job: MemoryJobRow,
  db: DbQueryable,
): Promise<CurrentSource> {
  const source = job.source_id
    ? await getCurrentMemorySource(job.source_id, db)
    : null;
  if (
    !source ||
    source.owner_user_id !== job.owner_user_id ||
    source.scope_id !== job.scope_id ||
    source.epoch !== job.epoch ||
    !source.learning_enabled ||
    source.revision !== job.source_revision
  )
    throw new StaleMemoryJob('MEMORY.SOURCE_CHANGED');
  const excluded = await db.query(
    'SELECT 1 FROM memory_exclusions WHERE source_id=$1 AND (quote_start IS NULL OR quote_end IS NULL) LIMIT 1',
    [source.id],
  );
  if (excluded.rows[0]) throw new StaleMemoryJob('MEMORY.EXCLUDED');
  await assertAutomaticMemorySourceCurrent(job, source, db);
  return source;
}

async function supportedItem(
  item: MemoryItemRow,
  db: DbQueryable,
): Promise<boolean> {
  const { rows } = await db.query<{
    source_id: string;
    source_revision: number;
    source_hash: string;
    quote: string;
  }>(
    'SELECT source_id,source_revision,source_hash,quote FROM memory_evidence WHERE item_id=$1 AND revoked_at IS NULL',
    [item.id],
  );
  for (const proof of rows) {
    const source = await getCurrentMemorySource(proof.source_id, db);
    if (
      !source ||
      source.owner_user_id !== item.owner_user_id ||
      (source.memory_space_id ??
        source.identity_snapshot?.memorySpaceId ??
        source.scope_id) !== item.scope_id ||
      source.revision !== proof.source_revision ||
      source.content_hash !== proof.source_hash ||
      source.epoch !== item.epoch ||
      source.source_role === 'assistant' ||
      !source.content.includes(proof.quote) ||
      item.content.normalize('NFKC').trim().replace(/\s+/g, ' ') !==
        proof.quote.normalize('NFKC').trim().replace(/\s+/g, ' ')
    )
      continue;
    const excluded = await db.query(
      'SELECT 1 FROM memory_exclusions WHERE source_id=$1 AND (quote_start IS NULL OR quote_end IS NULL) LIMIT 1',
      [source.id],
    );
    if (!excluded.rows[0]) return true;
  }
  return false;
}

async function activeFacts(
  scope: MemoryRequestScope,
  subjectIds: string[],
  db: DbQueryable,
  itemIds?: string[],
): Promise<MemoryItemRow[]> {
  const { rows } = await db.query<MemoryItemRow>(
    `SELECT i.* FROM memory_items i JOIN memory_entities e ON e.id=i.subject_id
       LEFT JOIN client_profiles c ON c.id=e.client_id
     WHERE i.scope_id=$1 AND i.owner_user_id=$2 AND i.subject_id=ANY($3::text[])
       AND i.status='active' AND i.epoch=$4 AND i.assertion_type<>'inferred'
       AND ($5::text[] IS NULL OR i.id=ANY($5::text[]))
       AND e.owner_user_id=$2 AND e.deleted_at IS NULL AND (e.client_id IS NULL OR c.user_id=$2 AND c.deleted_at IS NULL)
       AND NOT EXISTS(SELECT 1 FROM memory_exclusions x WHERE x.scope_id=i.scope_id AND x.owner_user_id=$2
         AND (x.subject_id IS NULL OR x.subject_id=i.subject_id)
         AND (x.family_id=i.family_id OR x.content_hash=i.content_hash OR x.fact_key=i.fact_key)
         AND (x.persistent OR i.observed_at<=x.cutoff_at))
     ORDER BY i.observed_at DESC,i.source_sequence DESC,i.id LIMIT 128`,
    [
      memorySpaceId(scope),
      scope.ownerUserId,
      subjectIds,
      scope.epoch,
      itemIds ?? null,
    ],
  );
  const supported: MemoryItemRow[] = [];
  for (const item of rows)
    if (await supportedItem(item, db)) supported.push(item);
  return supported;
}

async function recoverReservations(job: MemoryJobRow): Promise<void> {
  const { rows } = await getDbPool().query<{
    id: string;
    day: string;
    purpose: string;
    owner_user_id: string;
    reserved_tokens: string;
  }>(
    `SELECT id,day::text,purpose,owner_user_id,reserved_tokens::text FROM memory_budget_reservations
     WHERE job_id=$1 AND state='pending' AND lease_token IS DISTINCT FROM $2`,
    [job.id, job.lease_token],
  );
  for (const row of rows) {
    const reservation: MemoryBudgetReservation = {
      id: row.id,
      day: row.day,
      purpose: row.purpose,
      ownerUserId: row.owner_user_id,
      tokens: Number(row.reserved_tokens),
      jobId: job.id,
    };
    await settleMemoryBudget(reservation, {
      purpose: `memory.${job.kind}.recovered`,
      modelConfigId: 'unknown',
      model: 'unknown',
      durationMs: 0,
    });
  }
}

async function budgeted<T extends MemoryModelResult>(
  job: MemoryJobRow,
  policy: MemoryRuntimePolicy,
  purpose: string,
  tokens: number,
  run: () => Promise<T>,
): Promise<T> {
  const reservationArgs = {
    ownerUserId: job.owner_user_id,
    purpose,
    tokens,
    policy,
    jobId: job.id,
    jobLeaseToken: job.lease_token ?? undefined,
  };
  const reservation = await reserveMemoryBudget(reservationArgs);
  const started = performance.now();
  let result: T;
  try {
    result = await run();
  } catch (error) {
    await settleMemoryBudget(reservation, {
      purpose,
      modelConfigId:
        error instanceof MemoryModelError
          ? (error.modelConfigId ?? 'unknown')
          : 'unknown',
      model:
        error instanceof MemoryModelError
          ? (error.model ?? 'unknown')
          : 'unknown',
      durationMs: Math.round(performance.now() - started),
      usage: error instanceof MemoryModelError ? error.usage : undefined,
    });
    throw error;
  }
  await settleMemoryBudget(reservation, { purpose, ...result });
  return result;
}

interface Completion {
  state?: 'pending' | 'succeeded' | 'skipped';
  payload?: Record<string, unknown>;
  processedCount?: number;
  totalCount?: number;
  errorCode?: string;
}

async function applyJob(
  job: MemoryJobRow,
  options: MemoryJobOptions,
  needsLearning: boolean,
  apply: (
    db: pg.PoolClient,
    scope: MemoryRequestScope,
  ) => Promise<Completion | void>,
): Promise<void> {
  await withMemoryTransaction(async (db) => {
    const root = await lockMemoryRoot(job.scope_id, db);
    await assertLease(job, db, true);
    const policy = await getMemoryRuntimePolicy(db);
    if (!policy.enabled) throw new StaleMemoryJob('MEMORY.DISABLED');
    const source = job.source_id
      ? needsLearning
        ? await currentSource(job, db)
        : await getCurrentMemorySource(job.source_id, db)
      : undefined;
    if (
      job.source_id &&
      (!source ||
        source.owner_user_id !== job.owner_user_id ||
        source.scope_id !== job.scope_id ||
        source.epoch !== job.epoch ||
        source.revision !== job.source_revision)
    )
      throw new StaleMemoryJob('MEMORY.SOURCE_CHANGED');
    const scope = await jobScope(
      job,
      db,
      root,
      needsLearning,
      source?.identity_snapshot,
      source?.memory_space_id,
    );
    options.signal?.throwIfAborted();
    const completion = (await apply(db, scope)) ?? {};
    options.signal?.throwIfAborted();
    const state = completion.state ?? 'succeeded';
    await db.query(
      `UPDATE memory_jobs SET state=$3,lease_token=NULL,lease_until=NULL,
       payload=COALESCE($4::jsonb,payload),processed_count=COALESCE($5,processed_count),
       total_count=COALESCE($6,total_count),error_code=$7,
       attempts=CASE WHEN $3='pending' THEN 0 ELSE attempts END,
       next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE id=$1 AND lease_token=$2 AND state='running'`,
      [
        job.id,
        job.lease_token,
        state,
        completion.payload ? JSON.stringify(completion.payload) : null,
        completion.processedCount ?? null,
        completion.totalCount ?? null,
        completion.errorCode ?? null,
      ],
    );
  });
}

function sourceInput(
  source: CurrentSource,
  scope: MemoryRequestScope,
  content = source.content,
): MemorySourceInput {
  return {
    id: source.id,
    revision: source.revision,
    role: source.source_role,
    content,
    observedAt: isoDate(source.observed_at),
    subjectId: source.subject_id,
    speakerSubjectId:
      source.identity_snapshot?.speakerSubjectId ??
      actorSubjectId(source.identity_snapshot ?? scope),
    subjectName: source.subject_name,
    subjectKind: source.subject_kind as MemorySourceInput['subjectKind'],
    speakerKind: scope.actorKey.startsWith('user:') ? 'owner' : 'sender',
  };
}

function existingFact(item: MemoryItemRow): MemoryExistingFact {
  return {
    id: item.id,
    subjectId: item.subject_id,
    content: item.content,
    kind: item.kind,
    factKey: item.fact_key ?? undefined,
    observedAt: isoDate(item.observed_at),
  };
}

/** Only complete paragraphs or sentences are eligible extraction batches. */
export function splitMemoryExtractionSource(
  source: MemorySourceInput,
  existing: MemoryExistingFact[],
  policy: MemoryRuntimePolicy,
): string[] {
  const fits = (content: string) =>
    estimateMemoryExtractionInput([{ ...source, content }], existing) <=
    policy.extraction_input_tokens;
  if (fits(source.content)) return [source.content];
  if (
    /(?:假设|假如|如果|要是|倘若|据说|听说|预测|推测|模型|AI\b|[“”「」『』]|(?:没有|并非|未曾|尚未|不曾|从未|不是|计划|打算|准备)[^。！？!?]*[：:])|\b(?:if|suppose|hypothetical|predict|said)\b/i.test(
      source.content,
    )
  )
    throw new MemoryError(
      '来源过长且包含不能安全分离的限定上下文，请手工拆分完整记录。',
      422,
      'MEMORY.SOURCE_TOO_LARGE',
    );
  const paragraphs = source.content.match(/[\s\S]+?(?:\n[ \t]*\n+|$)/g) ?? [];
  const units: string[] = [];
  for (const paragraph of paragraphs) {
    if (fits(paragraph)) {
      units.push(paragraph);
      continue;
    }
    const sentences = Array.from(
      new Intl.Segmenter('zh', { granularity: 'sentence' }).segment(paragraph),
      ({ segment }) => segment,
    );
    for (const sentence of sentences) {
      if (!fits(sentence))
        throw new MemoryError(
          '单条完整陈述超过记忆模型输入预算，请提高预算或手工拆分。',
          422,
          'MEMORY.SOURCE_TOO_LARGE',
        );
      units.push(sentence);
    }
  }
  const batches: string[] = [];
  for (const unit of units) {
    const previous = batches.at(-1);
    if (previous !== undefined && fits(previous + unit))
      batches[batches.length - 1] += unit;
    else batches.push(unit);
  }
  if (!batches.length)
    throw new MemoryError('来源无法安全拆分。', 422, 'MEMORY.SOURCE_TOO_LARGE');
  return batches;
}

async function processExtract(
  job: MemoryJobRow,
  policy: MemoryRuntimePolicy,
  options: MemoryJobOptions,
): Promise<void> {
  const db = getDbPool();
  const source = await currentSource(job, db);
  const scope = await jobScope(
    job,
    db,
    undefined,
    true,
    source.identity_snapshot,
    source.memory_space_id,
  );
  if (
    source.source_role === 'assistant' ||
    source.subject_kind === 'unresolved'
  )
    throw new StaleMemoryJob('MEMORY.INELIGIBLE_SOURCE');
  const supported = await activeFacts(
    scope,
    [...new Set([scope.subjectId, actorSubjectId(scope)])],
    db,
  );
  const existing = supported.map(existingFact);
  const input = sourceInput(source, scope);
  // Existing facts are optional context; canonical source statements are never cropped.
  while (
    existing.length &&
    estimateMemoryExtractionInput([{ ...input, content: '' }], existing) >
      policy.extraction_input_tokens / 2
  )
    existing.pop();
  const storedBatches = job.payload.extractionBatches as
    | Array<{ start: number; end: number }>
    | undefined;
  let batches: string[];
  let spans: Array<{ start: number; end: number }>;
  if (storedBatches) {
    if (
      !Array.isArray(storedBatches) ||
      storedBatches.some(
        (span, index) =>
          !Number.isSafeInteger(span.start) ||
          !Number.isSafeInteger(span.end) ||
          span.start !== (index ? storedBatches[index - 1].end : 0) ||
          span.end <= span.start ||
          span.end > source.content.length,
      ) ||
      storedBatches.at(-1)?.end !== source.content.length
    )
      throw new MemoryError(
        '记忆提炼分段进度无效。',
        409,
        'MEMORY.INVALID_CURSOR',
      );
    spans = storedBatches;
    batches = spans.map((span) => source.content.slice(span.start, span.end));
  } else {
    batches = splitMemoryExtractionSource(input, [], policy);
    let start = 0;
    spans = batches.map((content) => {
      const span = { start, end: start + content.length };
      start = span.end;
      return span;
    });
  }
  const cursor = Number(job.payload.extractionCursor ?? 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= batches.length)
    throw new MemoryError('记忆提炼进度无效。', 409, 'MEMORY.INVALID_CURSOR');
  const batch = { ...input, content: batches[cursor] };
  while (
    existing.length &&
    estimateMemoryExtractionInput([batch], existing) >
      policy.extraction_input_tokens
  )
    existing.pop();
  if (
    estimateMemoryExtractionInput([batch], existing) >
    policy.extraction_input_tokens
  )
    throw new MemoryError(
      '已保存的完整分段超过当前输入预算，请调整预算后重试。',
      422,
      'MEMORY.SOURCE_TOO_LARGE',
    );
  const result = await budgeted(
    job,
    policy,
    'memory.extract',
    estimateMemoryExtractionInput([batch], existing) +
      policy.extraction_output_tokens,
    () =>
      (options.processors?.extract ?? extractMemoryCandidates)({
        sources: [batch],
        existing,
        policy,
        signal: options.signal,
        runner: options.modelOptions?.runner,
        resolveModel: options.modelOptions?.resolveModel,
      }),
  );
  await applyJob(job, options, true, async (client, currentScope) => {
    const actualSource = await currentSource(job, client);
    if (
      actualSource.content_hash !== source.content_hash ||
      actualSource.content !== source.content
    )
      throw new StaleMemoryJob('MEMORY.SOURCE_CHANGED');
    for (const candidate of result.candidates) {
      if (
        candidate.sourceId !== source.id ||
        candidate.content !== candidate.quote ||
        !batch.content.includes(candidate.quote)
      )
        throw new MemoryError(
          '记忆模型返回了无效的证据绑定。',
          422,
          'MEMORY.INVALID_EVIDENCE',
        );
      try {
        await insertMemoryItem(client, {
          scope: currentScope,
          subjectId: candidate.subjectId,
          content: candidate.content,
          kind: candidate.kind,
          factKey: candidate.factKey,
          assertionType: candidate.assertionType,
          origin: 'automatic',
          source: actualSource,
          quote: candidate.quote,
          validFrom: candidate.validFrom,
          validTo: candidate.validTo,
          supersedesId: candidate.supersedesId,
        });
      } catch (error) {
        if (
          error instanceof MemoryError &&
          ['MEMORY.EXCLUDED', 'MEMORY.STALE_SOURCE'].includes(error.code)
        )
          continue;
        throw error;
      }
    }
    const done = cursor + 1 === batches.length;
    if (done)
      await client.query(
        'UPDATE memory_sources SET extracted_revision=$2 WHERE id=$1 AND revision=$2',
        [source.id, source.revision],
      );
    return {
      state: done ? 'succeeded' : 'pending',
      payload: {
        ...job.payload,
        extractionBatches: spans,
        extractionCursor: cursor + 1,
      },
      processedCount: cursor + 1,
      totalCount: batches.length,
    };
  });
}

export interface MemoryBackfillInput {
  session_ids?: string[];
  scope_ids?: string[];
  client_id?: string;
  from?: string;
  to?: string;
}

function backfillInput(value: MemoryBackfillInput): MemoryBackfillInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MemoryError('回填条件格式无效。');
  if (
    value.scope_ids !== undefined &&
    (!Array.isArray(value.scope_ids) ||
      !value.scope_ids.length ||
      value.scope_ids.length > 1000 ||
      value.scope_ids.some(
        (id) => typeof id !== 'string' || !id || id.length > 200,
      ))
  )
    throw new MemoryError('回填范围列表无效。');
  if (
    value.session_ids !== undefined &&
    (!Array.isArray(value.session_ids) ||
      !value.session_ids.length ||
      value.session_ids.length > 1000 ||
      value.session_ids.some(
        (id) => typeof id !== 'string' || !id || id.length > 200,
      ))
  )
    throw new MemoryError('回填会话列表无效。');
  if (
    value.client_id !== undefined &&
    (typeof value.client_id !== 'string' ||
      !value.client_id ||
      value.client_id.length > 200)
  )
    throw new MemoryError('回填命主标识无效。');
  for (const date of [value.from, value.to])
    if (date !== undefined && !isMemoryIsoInstant(date))
      throw new MemoryError('回填时间范围无效。');
  if (value.from && value.to && Date.parse(value.from) > Date.parse(value.to))
    throw new MemoryError('回填开始时间不能晚于结束时间。');
  return {
    ...(value.scope_ids
      ? { scope_ids: [...new Set(value.scope_ids)].sort() }
      : {}),
    ...(value.session_ids
      ? { session_ids: [...new Set(value.session_ids)].sort() }
      : {}),
    ...(value.client_id ? { client_id: value.client_id } : {}),
    ...(value.from ? { from: new Date(value.from).toISOString() } : {}),
    ...(value.to ? { to: new Date(value.to).toISOString() } : {}),
  };
}

function dto(job: MemoryJobRow): MemoryJobDto {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    attempts: job.attempts,
    processed_count: job.processed_count,
    total_count: job.total_count,
    error_code: job.error_code,
    created_at: isoDate(job.created_at),
    updated_at: isoDate(job.updated_at),
  };
}

export async function startMemoryBackfill(
  ownerUserId: string,
  input: MemoryBackfillInput = {},
): Promise<MemoryJobDto> {
  const filter = backfillInput(input);
  return withMemoryTransaction(async (db) => {
    const root = await ensureOwnerMemoryScope(ownerUserId, db);
    const locked = await lockMemoryRoot(root.id, db);
    if (!locked.learning_enabled)
      throw new MemoryError(
        '请先开启自动学习，再回填历史记录。',
        409,
        'MEMORY.LEARNING_DISABLED',
      );
    const policy = await getMemoryRuntimePolicy(db);
    if (!policy.enabled)
      throw new MemoryError('记忆功能已停用。', 409, 'MEMORY.DISABLED');
    if (filter.session_ids) {
      const sessions = await db.query<{ id: string }>(
        'SELECT id FROM chat_sessions WHERE user_id=$1 AND deleted_at IS NULL AND id=ANY($2::text[])',
        [ownerUserId, filter.session_ids],
      );
      if (sessions.rows.length !== filter.session_ids.length)
        throw new MemoryError(
          '部分会话不存在或无权访问。',
          403,
          'MEMORY.SESSION_DENIED',
        );
    }
    if (filter.scope_ids) {
      const scopes = await db.query<{ id: string }>(
        'SELECT id FROM memory_scopes WHERE owner_user_id=$1 AND id=ANY($2::text[])',
        [ownerUserId, filter.scope_ids],
      );
      if (scopes.rows.length !== filter.scope_ids.length)
        throw new MemoryError(
          '部分记忆范围不存在或无权访问。',
          403,
          'MEMORY.SCOPE_DENIED',
        );
    }
    if (filter.client_id) {
      const client = await db.query(
        'SELECT id FROM client_profiles WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
        [filter.client_id, ownerUserId],
      );
      if (!client.rows[0])
        throw new MemoryError(
          '命主不存在或已归档。',
          403,
          'MEMORY.SUBJECT_INACTIVE',
        );
    }
    const scope = await jobScope(
      {
        owner_user_id: ownerUserId,
        scope_id: root.id,
        subject_id: `self:${ownerUserId}`,
        epoch: locked.epoch,
      } as MemoryJobRow,
      db,
      locked,
      true,
    );
    const active = await db.query<MemoryJobRow>(
      `SELECT * FROM memory_jobs WHERE scope_id=$1 AND kind='backfill' AND epoch=$2
       AND state IN ('pending','running','paused') AND payload->'filter'=$3::jsonb ORDER BY created_at LIMIT 1`,
      [root.id, locked.epoch, JSON.stringify(filter)],
    );
    if (active.rows[0]) return dto(active.rows[0]);
    const clock = await db.query<{ cutoff: string }>(
      'SELECT clock_timestamp()::text AS cutoff',
    );
    const key = `backfill:${root.id}:${locked.epoch}:${memoryHash(JSON.stringify(filter))}:${randomUUID()}`;
    const id = await queueMemoryJob(db, {
      scope,
      kind: 'backfill',
      eventType: 'manual_backfill',
      key,
      payload: { filter, cutoff: clock.rows[0].cutoff, cursor: null },
    });
    const { rows } = await db.query<MemoryJobRow>(
      'SELECT * FROM memory_jobs WHERE id=$1',
      [id],
    );
    return dto(rows[0]);
  });
}

interface BackfillMessage {
  id: string;
  account_id: string;
  user_id: string | null;
  session_id: string;
  sender: string;
  content: string;
  cursor_at: string;
  is_from_me: boolean;
  is_bot_message: boolean;
  metadata: Record<string, unknown> | null;
  admitted_scope: MemoryRequestScope | null;
  admitted_request_id?: string | null;
  historical_scope_id?: string | null;
}

async function backfillScope(
  db: pg.PoolClient,
  job: MemoryJobRow,
  message: BackfillMessage,
): Promise<{ scope: MemoryRequestScope; certain: boolean }> {
  const admitted = message.admitted_scope;
  if (admitted && admitted.ownerUserId === job.owner_user_id) {
    const found = await db.query<MemoryScopeRow>(
      'SELECT * FROM memory_scopes WHERE id=$1 AND owner_user_id=$2',
      [admitted.scopeId, job.owner_user_id],
    );
    const row = found.rows[0];
    if (row)
      return {
        scope: {
          ...admitted,
          epoch: job.epoch,
          learningEnabled: true,
        },
        certain: true,
      };
  }
  let scope = await jobScope(job, db, undefined, true);
  if (
    message.historical_scope_id &&
    message.historical_scope_id !== scope.scopeId
  ) {
    const { rows } = await db.query<MemoryScopeRow>(
      'SELECT * FROM memory_scopes WHERE id=$1 AND owner_user_id=$2',
      [message.historical_scope_id, job.owner_user_id],
    );
    if (rows[0])
      scope = {
        ...scope,
        scopeId: rows[0].id,
        actorKey: rows[0].actor_key,
        audienceKey: rows[0].audience_key,
        speakerSubjectId: undefined,
        bindingRevision: rows[0].binding_revision ?? 1,
        ownerMemoryAccess: false,
      };
  }
  const subjectId = `unresolved:${memoryHash(`${message.session_id}:${message.sender}`)}`;
  await db.query(
    "INSERT INTO memory_entities(id,owner_user_id,scope_id,kind,name) VALUES($1,$2,$3,'unresolved','身份未确认的历史对话') ON CONFLICT(id) DO NOTHING",
    [subjectId, job.owner_user_id, scope.scopeId],
  );
  return { scope: { ...scope, subjectId }, certain: false };
}

async function processBackfill(
  job: MemoryJobRow,
  policy: MemoryRuntimePolicy,
  options: MemoryJobOptions,
): Promise<void> {
  await jobScope(job, getDbPool(), undefined, true);
  const filter = backfillInput(
    (job.payload.filter ?? {}) as MemoryBackfillInput,
  );
  const cursor = job.payload.cursor as {
    at: string;
    accountId: string;
    id: string;
  } | null;
  if (
    cursor &&
    (typeof cursor.at !== 'string' ||
      !cursor.at ||
      cursor.at.length > 100 ||
      typeof cursor.accountId !== 'string' ||
      typeof cursor.id !== 'string')
  )
    throw new MemoryError('历史回填进度无效。', 409, 'MEMORY.INVALID_CURSOR');
  const root = await readMemoryRoot(job.scope_id);
  const cutoff = job.payload.cutoff;
  if (typeof cutoff !== 'string' || !cutoff || cutoff.length > 100)
    throw new MemoryError(
      '历史回填截止时间无效。',
      409,
      'MEMORY.INVALID_CURSOR',
    );
  const { rows } = await getDbPool().query<BackfillMessage>(
    `SELECT m.*,m.timestamp::text AS cursor_at,COALESCE(NULLIF(captured.identity_snapshot,'{}'::jsonb),r.memory_scope) AS admitted_scope,r.request_id AS admitted_request_id,historical_scope.id AS historical_scope_id FROM messages m JOIN chat_sessions s
       ON s.id=m.session_id AND s.account_id=m.account_id
     LEFT JOIN LATERAL(SELECT scope_id,identity_snapshot FROM memory_sources
       WHERE owner_user_id=$1 AND message_id=m.id AND account_id=m.account_id ORDER BY revision DESC LIMIT 1) captured ON true
     LEFT JOIN LATERAL(SELECT memory_scope,request_id FROM agent_requests WHERE owner_user_id=$1 AND session_id=s.id
       AND (user_message_id=m.id OR request_id=m.metadata->>'request_id') AND memory_scope IS NOT NULL
       ORDER BY created_at DESC LIMIT 1) r ON true
     LEFT JOIN LATERAL(SELECT COALESCE(captured.scope_id,r.memory_scope->>'scopeId',
       CASE WHEN m.metadata->>'source_channel'='wechat' THEN
         (SELECT scoped.id FROM memory_scopes scoped WHERE scoped.owner_user_id=$1 AND scoped.actor_key=concat('wechat:',m.metadata->>'wechat_account_id',':',m.metadata->>'sender_hash') LIMIT 1)
         ELSE NULL END,$13::text) AS id) historical_scope ON true
     WHERE s.user_id=$1 AND s.deleted_at IS NULL AND m.deleted_at IS NULL AND m.content<>''
       AND ($2::text[] IS NULL OR s.id=ANY($2::text[])) AND ($3::text IS NULL OR s.client_id=$3)
       AND m.timestamp>=COALESCE($4::timestamptz,'-infinity') AND m.timestamp<=LEAST(COALESCE($5::timestamptz,'infinity'),$6::timestamptz)
       AND ($7::timestamptz IS NULL OR (m.timestamp,m.account_id,m.id)>($7::timestamptz,$8::text,$9::text))
       AND ($10::timestamptz IS NULL OR m.timestamp>$10)
       AND ($12::text[] IS NULL OR historical_scope.id=ANY($12::text[]))
       AND NOT m.is_from_me AND m.is_bot_message IS NOT TRUE
     ORDER BY m.timestamp,m.account_id,m.id LIMIT $11`,
    [
      job.owner_user_id,
      filter.session_ids ?? null,
      filter.client_id ?? null,
      filter.from ?? null,
      filter.to ?? null,
      cutoff,
      cursor?.at ?? null,
      cursor?.accountId ?? null,
      cursor?.id ?? null,
      root.cleared_at ?? null,
      policy.backfill_batch_size,
      filter.scope_ids ?? null,
      job.scope_id,
    ],
  );
  await applyJob(job, options, true, async (db) => {
    for (const message of rows) {
      options.signal?.throwIfAborted();
      let identity: Awaited<ReturnType<typeof backfillScope>>;
      try {
        identity = await backfillScope(db, job, message);
        await assertMemorySubject(identity.scope, identity.scope.subjectId, db);
      } catch (error) {
        if (
          error instanceof MemoryError &&
          ['MEMORY.SUBJECT_INACTIVE', 'MEMORY.SUBJECT_MISSING'].includes(
            error.code,
          )
        )
          continue;
        throw error;
      }
      const { scope: messageScope, certain } = identity;
      const prior = await db.query<{ id: string }>(
        "SELECT id FROM memory_sources WHERE owner_user_id=$1 AND source_kind='message' AND source_ref=$2 ORDER BY revision DESC LIMIT 1",
        [job.owner_user_id, `${message.account_id}:${message.id}`],
      );
      if (prior.rows[0]) {
        try {
          await reauthorizeMemorySourceForBackfill(db, {
            scope: messageScope,
            sourceId: prior.rows[0].id,
            backfillJobId: job.id,
            requestId: message.admitted_request_id ?? undefined,
          });
        } catch (error) {
          if (
            error instanceof MemoryError &&
            ['MEMORY.BINDING_CHANGED', 'MEMORY.SUBJECT_INACTIVE'].includes(
              error.code,
            )
          )
            continue;
          throw error;
        }
        continue;
      }
      if (certain) {
        if (!message.admitted_request_id)
          throw new StaleMemoryJob('MEMORY.REQUEST_MISSING');
        await captureMemorySource(db, {
          scope: messageScope,
          requestId: message.admitted_request_id,
          messageId: message.id,
          accountId: message.account_id,
          sessionId: message.session_id,
          content: message.content,
          observedAt: message.cursor_at,
          backfillJobId: job.id,
        });
      } else {
        const id = memoryHash(
          `${messageScope.scopeId}\0${message.account_id}:${message.id}\0${memoryHash(message.content)}`,
        );
        await db.query(
          `INSERT INTO memory_sources(id,owner_user_id,scope_id,subject_id,source_kind,source_role,source_ref,
           account_id,message_id,session_id,content_hash,observed_at,epoch,learning_enabled)
           SELECT $1,$2,$3,$4,'message','user',$5,$6,$7,$8,$9,$10,$11,true
           WHERE EXISTS(SELECT 1 FROM messages WHERE id=$7 AND account_id=$6 AND deleted_at IS NULL)
           ON CONFLICT(id) DO NOTHING`,
          [
            id,
            job.owner_user_id,
            messageScope.scopeId,
            messageScope.subjectId,
            `${message.account_id}:${message.id}`,
            message.account_id,
            message.id,
            message.session_id,
            memoryHash(message.content),
            message.cursor_at,
            job.epoch,
          ],
        );
        await indexMemoryText(db, {
          ownerUserId: job.owner_user_id,
          scopeId: messageScope.scopeId,
          subjectId: messageScope.subjectId,
          kind: 'source',
          id,
          revision: 1,
          text: message.content,
          observedAt: message.cursor_at,
        });
      }
    }
    const last = rows.at(-1);
    const done = rows.length < policy.backfill_batch_size;
    return {
      state: done ? 'succeeded' : 'pending',
      payload: {
        ...job.payload,
        cursor: last
          ? {
              at: last.cursor_at,
              accountId: last.account_id,
              id: last.id,
            }
          : cursor,
      },
      processedCount: job.processed_count + rows.length,
      ...(done ? { totalCount: job.processed_count + rows.length } : {}),
    };
  });
}

function errorCode(error: unknown): string {
  return error instanceof MemoryError || error instanceof MemoryModelError
    ? error.code
    : 'MEMORY.UNEXPECTED';
}

async function failJob(
  job: MemoryJobRow,
  policy: MemoryRuntimePolicy,
  error: unknown,
): Promise<void> {
  const code = errorCode(error);
  const stale =
    error instanceof StaleMemoryJob ||
    (error instanceof MemoryError &&
      [
        'MEMORY.REVOKED',
        'MEMORY.SUBJECT_INACTIVE',
        'MEMORY.SCOPE_MISSING',
        'MEMORY.SOURCE_CHANGED',
        'MEMORY.EXCLUDED',
      ].includes(code));
  const configuration =
    /(?:NOT_CONFIGURED|UNSUPPORTED|INVALID_POLICY|SOURCE_TOO_LARGE|INVALID_CURSOR|INVALID_EVIDENCE)/.test(
      code,
    );
  const budget = code === 'MEMORY.BUDGET_EXHAUSTED';
  const retry =
    !stale && !configuration && (budget || job.attempts < policy.max_attempts);
  const delay = budget
    ? Date.parse(
        `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`,
      ) - Date.now()
    : Math.min(60_000, 1000 * 2 ** Math.max(0, job.attempts - 1));
  await getDbPool().query(
    `UPDATE memory_jobs SET state=$3,error_code=$4,lease_token=NULL,lease_until=NULL,
     next_attempt_at=clock_timestamp()+$5::int*interval '1 millisecond',
     attempts=CASE WHEN $6::boolean THEN GREATEST(0,attempts-1) ELSE attempts END,updated_at=clock_timestamp()
     WHERE id=$1 AND lease_token=$2 AND state='running'`,
    [
      job.id,
      job.lease_token,
      stale ? 'skipped' : retry ? 'pending' : 'failed',
      code,
      delay,
      budget,
    ],
  );
}

export async function processMemoryJob(
  job: MemoryJobRow,
  policy: MemoryRuntimePolicy,
  options: MemoryJobOptions = {},
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), policy.job_timeout_ms);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const bounded = { ...options, signal };
  const work = async () => {
    if (!policy.enabled) throw new StaleMemoryJob('MEMORY.DISABLED');
    await assertLease(job, getDbPool());
    signal.throwIfAborted();
    await recoverReservations(job);
    signal.throwIfAborted();
    switch (job.kind) {
      case 'extract':
        await processExtract(job, policy, bounded);
        break;
      case 'backfill':
        await processBackfill(job, policy, bounded);
        break;
    }
  };
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(
        new MemoryModelError(
          options.signal?.aborted
            ? 'MEMORY_MODEL_CANCELLED'
            : 'MEMORY_MODEL_TIMEOUT',
          '记忆后台任务已取消或超时。',
        ),
      );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([work(), aborted]);
  } catch (error) {
    const outcome =
      signal.aborted && !(error instanceof MemoryModelError)
        ? new MemoryModelError(
            options.signal?.aborted
              ? 'MEMORY_MODEL_CANCELLED'
              : 'MEMORY_MODEL_TIMEOUT',
            '记忆后台任务已取消或超时。',
          )
        : error;
    await failJob(job, policy, outcome);
    if (
      !(outcome instanceof MemoryError) &&
      !(outcome instanceof MemoryModelError)
    )
      throw outcome;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

export async function changeMemoryJobState(
  ownerUserId: string,
  jobId: string,
  action: 'pause' | 'resume',
): Promise<MemoryJobDto> {
  if (action !== 'pause' && action !== 'resume')
    throw new MemoryError('记忆任务操作无效。');
  return withMemoryTransaction(async (db) => {
    const found = await db.query<MemoryJobRow>(
      'SELECT * FROM memory_jobs WHERE id=$1 AND owner_user_id=$2',
      [jobId, ownerUserId],
    );
    if (!found.rows[0])
      throw new MemoryError('记忆任务不存在。', 404, 'MEMORY.JOB_MISSING');
    const job = found.rows[0];
    await lockMemoryRoot(job.scope_id, db);
    const { rows } = await db.query<MemoryJobRow>(
      'SELECT * FROM memory_jobs WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',
      [jobId, ownerUserId],
    );
    const current = rows[0];
    if (
      action === 'pause' &&
      (current.state === 'pending' || current.state === 'running')
    ) {
      const changed = await db.query<MemoryJobRow>(
        "UPDATE memory_jobs SET state='paused',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
        [jobId],
      );
      return dto(changed.rows[0]);
    }
    if (action === 'resume' && current.state === 'paused') {
      await jobScope(current, db, undefined, true);
      const changed = await db.query<MemoryJobRow>(
        "UPDATE memory_jobs SET state='pending',attempts=0,next_attempt_at=clock_timestamp(),error_code=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
        [jobId],
      );
      return dto(changed.rows[0]);
    }
    return dto(current);
  });
}

export async function retryMemoryJob(jobId: string): Promise<MemoryJobDto> {
  return withMemoryTransaction(async (db) => {
    const found = await db.query<MemoryJobRow>(
      'SELECT * FROM memory_jobs WHERE id=$1',
      [jobId],
    );
    if (!found.rows[0])
      throw new MemoryError('记忆任务不存在。', 404, 'MEMORY.JOB_MISSING');
    await lockMemoryRoot(found.rows[0].scope_id, db);
    const { rows } = await db.query<MemoryJobRow>(
      'SELECT * FROM memory_jobs WHERE id=$1 FOR UPDATE',
      [jobId],
    );
    const job = rows[0];
    if (!['failed', 'skipped'].includes(job.state)) return dto(job);
    await jobScope(job, db, undefined, true);
    const changed = await db.query<MemoryJobRow>(
      "UPDATE memory_jobs SET state='pending',attempts=0,error_code=NULL,next_attempt_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
      [jobId],
    );
    return dto(changed.rows[0]);
  });
}

const JOB_RETENTION_BATCH = 1000;

/** Finished jobs are diagnostics only; failed jobs stay until the owner retries or clears them. */
export async function pruneFinishedMemoryJobs(
  options: { signal?: AbortSignal; retentionDays?: number } = {},
  db: DbQueryable = getDbPool(),
): Promise<number> {
  let total = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    const { rowCount } = await db.query(
      `DELETE FROM memory_jobs WHERE id IN(
         SELECT id FROM memory_jobs WHERE state IN ('succeeded','skipped','cancelled')
           AND updated_at<clock_timestamp()-$1::int*interval '1 day' LIMIT $2)`,
      [options.retentionDays ?? 7, JOB_RETENTION_BATCH],
    );
    total += rowCount ?? 0;
    if ((rowCount ?? 0) < JOB_RETENTION_BATCH) return total;
  }
}
