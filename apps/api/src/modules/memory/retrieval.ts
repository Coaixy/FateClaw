import type pg from 'pg';
import {
  estimateMemoryTokens,
  type MemoryExcerpt,
  type MemoryHydration,
  type MemoryReference,
  type MemoryRequestScope,
  type MemoryRuntimePolicy,
} from '@fateclaw/contracts/memory';
import {
  assertMemoryScopeCurrent,
  escapeMemoryLike,
  isoDate,
  memoryLexicalScore,
  memoryQueryTerms,
  type MemoryItemRow,
} from './domain.js';
import { MEMORY_PINNED_FACT_KEYS } from './extraction.js';
import {
  actorSubjectId,
  assertMemoryBindingCurrent,
  assertMemorySubject,
  getCurrentMemorySource,
  hasOwnerMemoryAudience,
  memorySpaceId,
  memoryRecallSourceContent,
  readMemoryRoot,
  readableMemorySpaces,
} from './repository.js';

interface SearchEntry {
  object_kind: 'item' | 'source';
  object_id: string;
  object_revision: number;
  search_text: string;
  chunk_start: number;
  chunk_end: number | null;
}

interface RecallContext {
  db: pg.PoolClient;
  scope: MemoryRequestScope;
  policy: MemoryRuntimePolicy;
  spaces: string[];
  signal?: AbortSignal;
}

export function memoryHydration(
  scope: MemoryRequestScope,
  policy: MemoryRuntimePolicy,
  status: MemoryHydration['status'],
  excerpts: MemoryExcerpt[] = [],
): MemoryHydration {
  return {
    status,
    epoch: scope.epoch,
    contextGeneration: scope.contextGeneration,
    contextAudience: scope.contextAudience ?? '',
    tokenBudget: policy.recall_token_budget,
    excerpts,
  };
}

/** Returns null when recall is switched off, so callers report `disabled` instead of an error. */
export async function authorizeMemoryRecall(
  db: pg.PoolClient,
  scope: MemoryRequestScope,
  policy: MemoryRuntimePolicy,
  signal?: AbortSignal,
): Promise<RecallContext | null> {
  if (!policy.enabled || !scope.recallEnabled) return null;
  const root = await readMemoryRoot(scope.scopeId, db);
  if (!root.recall_enabled) return null;
  assertMemoryScopeCurrent(scope, root, 'read');
  await assertMemoryBindingCurrent(scope, db);
  await assertMemorySubject(scope, scope.subjectId, db);
  return {
    db,
    scope,
    policy,
    spaces: await readableMemorySpaces(scope, db),
    signal,
  };
}

const subjectClientId = (subjectId: string) =>
  subjectId.startsWith('client:') ? subjectId.slice('client:'.length) : null;

async function keywordRecall(
  context: RecallContext,
  args: {
    query: string;
    subjectId?: string;
    after?: string;
    before?: string;
    limit?: number;
    /** The current conversation is already in the model context; its sources would only echo it. */
    excludeSessionId?: string;
  },
): Promise<MemoryReference[]> {
  const { db, scope, policy } = context;
  const subjectId = args.subjectId ?? scope.subjectId;
  if (subjectId !== scope.subjectId)
    await assertMemorySubject(scope, subjectId, db);
  const query = args.query.trim().slice(0, 2000);
  const terms = memoryQueryTerms(query);
  if (!terms.length) return [];
  const limit = Math.min(
    args.limit ?? policy.recall_max_results,
    policy.recall_max_results,
  );
  const owner = hasOwnerMemoryAudience(scope);
  const { rows } = await db.query<SearchEntry>(
    `SELECT x.object_kind,x.object_id,x.object_revision,x.search_text,x.chunk_start,x.chunk_end
     FROM memory_index_entries x
     WHERE x.owner_user_id=$2 AND x.scope_id=ANY($1::text[])
       AND (x.subject_id=$3 OR x.object_kind='source' AND $5::boolean AND EXISTS(
         SELECT 1 FROM memory_entities unknown_subject WHERE unknown_subject.id=x.subject_id AND unknown_subject.kind='unresolved')
         AND EXISTS(SELECT 1 FROM memory_sources unknown_source JOIN chat_sessions unknown_session ON unknown_session.id=unknown_source.session_id
           WHERE unknown_source.id=x.object_id AND unknown_session.client_id IS NOT DISTINCT FROM $10::text))
       AND (x.object_kind<>'source' OR $5::boolean OR EXISTS(
         SELECT 1 FROM memory_sources source JOIN memory_scopes actor ON actor.id=source.scope_id
         WHERE source.id=x.object_id AND source.scope_id=$4
           AND source.identity_snapshot->>'actorKey'=actor.actor_key AND source.identity_snapshot->>'audienceKey'=actor.audience_key
           AND source.identity_snapshot->>'contextAudience'=actor.audience_key
           AND COALESCE(source.identity_snapshot->>'bindingRevision','1')=actor.binding_revision::text))
       AND EXISTS(SELECT 1 FROM memory_entities e LEFT JOIN client_profiles c ON c.id=e.client_id
         WHERE e.id=x.subject_id AND e.deleted_at IS NULL AND (e.client_id IS NULL OR c.deleted_at IS NULL))
       AND x.observed_at>=COALESCE($6::timestamptz,'-infinity') AND x.observed_at<=COALESCE($7::timestamptz,'infinity')
       AND x.search_text ILIKE ANY($8::text[])
       AND (x.object_kind<>'source' OR $9::text IS NULL OR NOT EXISTS(
         SELECT 1 FROM memory_sources current WHERE current.id=x.object_id AND current.session_id=$9))
     -- Rank by matched terms before the cap; recency alone cut older relevant entries.
     ORDER BY (SELECT count(*) FROM unnest($8::text[]) pattern WHERE x.search_text ILIKE pattern) DESC,
       x.updated_at DESC LIMIT 120`,
    [
      context.spaces,
      scope.ownerUserId,
      subjectId,
      scope.scopeId,
      owner,
      args.after ?? null,
      args.before ?? null,
      terms.map((term) => `%${escapeMemoryLike(term)}%`),
      args.excludeSessionId ?? null,
      subjectClientId(subjectId),
    ],
  );
  const best = new Map<string, { reference: MemoryReference; score: number }>();
  for (const entry of rows) {
    const score = memoryLexicalScore(entry.search_text, query, terms);
    if (score <= 0) continue;
    const key = `${entry.object_kind}:${entry.object_id}:${entry.object_revision}`;
    if ((best.get(key)?.score ?? 0) >= score) continue;
    best.set(key, {
      reference: {
        kind: entry.object_kind,
        id: entry.object_id,
        revision: entry.object_revision,
        ...(entry.object_kind === 'source'
          ? {
              offset: entry.chunk_start,
              limit:
                (entry.chunk_end ??
                  entry.chunk_start + entry.search_text.length) -
                entry.chunk_start,
            }
          : {}),
      },
      score,
    });
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ reference, score }) => ({ ...reference, score }));
}
function page(
  reference: MemoryReference,
  length: number,
): { offset: number; limit: number } | null {
  const offset = reference.offset ?? 0;
  const limit = Math.min(reference.limit ?? 400, 400);
  if (offset < 0 || offset >= length || limit < 1) return null;
  return { offset, limit };
}

async function hydrateItem(
  context: RecallContext,
  reference: MemoryReference,
): Promise<MemoryExcerpt | null> {
  const { db, scope } = context;
  const { rows } = await db.query<
    MemoryItemRow & { subject_name: string; subject_kind: string }
  >(
    `SELECT i.*,e.name AS subject_name,e.kind AS subject_kind FROM memory_items i JOIN memory_entities e ON e.id=i.subject_id
     LEFT JOIN client_profiles c ON c.id=e.client_id
     WHERE i.id=$1 AND i.revision=$2 AND i.owner_user_id=$3 AND i.scope_id=ANY($4::text[])
       AND i.subject_id=ANY($5::text[]) AND i.status='active' AND i.assertion_type<>'inferred' AND i.epoch=$6
       AND e.deleted_at IS NULL AND (e.client_id IS NULL OR c.deleted_at IS NULL)
       AND NOT EXISTS(SELECT 1 FROM memory_exclusions x WHERE x.scope_id=i.scope_id
         AND (x.family_id=i.family_id OR x.content_hash=i.content_hash OR x.fact_key=i.fact_key AND x.subject_id=i.subject_id)
         AND (x.persistent OR i.observed_at<=x.cutoff_at))`,
    [
      reference.id,
      reference.revision,
      scope.ownerUserId,
      context.spaces,
      [scope.subjectId, actorSubjectId(scope)],
      scope.epoch,
    ],
  );
  const item = rows[0];
  if (
    !item ||
    (item.subject_id !== scope.subjectId && item.kind !== 'preference')
  )
    return null;
  const evidence = await db.query<{
    source_id: string;
    source_revision: number;
    quote: string;
    source_hash: string;
    quote_start: number | null;
  }>(
    'SELECT source_id,source_revision,quote,source_hash,quote_start FROM memory_evidence WHERE item_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC',
    [item.id],
  );
  if (item.origin === 'automatic') {
    let supported = false;
    for (const row of evidence.rows) {
      const source = await getCurrentMemorySource(row.source_id, db);
      if (
        source &&
        source.revision === row.source_revision &&
        source.content_hash === row.source_hash &&
        (await memoryRecallSourceContent(source, db)).includes(row.quote)
      ) {
        supported = true;
        break;
      }
    }
    if (!supported) return null;
  }
  const window = page(reference, item.content.length);
  if (!window) return null;
  const { offset, limit } = window;
  return {
    reference,
    text: item.content.slice(offset, offset + limit),
    // The shared reading rules (verbatim source text, first person) are in the system prompt.
    label: `${item.kind}${item.fact_key ? `(${item.fact_key})` : ''}：${item.subject_name}（${item.subject_kind}）${offset || limit < item.content.length ? ` ${offset}-${Math.min(offset + limit, item.content.length)}/${item.content.length}` : ''}`,
    observedAt: isoDate(item.observed_at),
    sourceReferences: evidence.rows.slice(0, 3).map((row) => ({
      kind: 'source' as const,
      id: row.source_id,
      revision: row.source_revision,
      offset: row.quote_start ?? 0,
      limit: Math.min(row.quote.length, 400),
    })),
    ...(offset + limit < item.content.length
      ? { nextReference: { ...reference, offset: offset + limit, limit } }
      : {}),
  };
}

async function hydrateSource(
  context: RecallContext,
  reference: MemoryReference,
): Promise<MemoryExcerpt | null> {
  const { db, scope } = context;
  const source = await getCurrentMemorySource(reference.id, db);
  if (
    !source ||
    source.revision !== reference.revision ||
    source.owner_user_id !== scope.ownerUserId ||
    source.epoch !== scope.epoch ||
    source.source_role === 'assistant'
  )
    return null;
  const space =
    source.memory_space_id ??
    source.identity_snapshot?.memorySpaceId ??
    source.scope_id;
  if (!context.spaces.includes(space)) return null;
  const owner = hasOwnerMemoryAudience(scope);
  const frozen = source.identity_snapshot;
  const ownOriginal =
    space === memorySpaceId(scope) &&
    source.scope_id === scope.scopeId &&
    frozen?.actorKey === scope.actorKey &&
    frozen.audienceKey === scope.audienceKey &&
    (frozen.contextAudience ?? '') === (scope.contextAudience ?? '') &&
    (frozen.bindingRevision ?? 1) === (scope.bindingRevision ?? 1);
  const restrictedProof = !owner && !ownOriginal;
  let visibleContent = await memoryRecallSourceContent(source, db);
  if (restrictedProof) {
    // Another actor's message discloses only the quote ranges that support a readable fact.
    const authorized = await db.query<{
      quote: string;
      quote_start: number | null;
      quote_end: number | null;
    }>(
      `SELECT e.quote,e.quote_start,e.quote_end FROM memory_evidence e JOIN memory_items i ON i.id=e.item_id
       WHERE e.source_id=$1 AND e.source_revision=$2 AND e.source_hash=$3 AND e.revoked_at IS NULL
         AND i.owner_user_id=$4 AND i.subject_id=$5 AND i.status='active' AND i.assertion_type<>'inferred'
         AND i.scope_id=ANY($6::text[])`,
      [
        source.id,
        source.revision,
        source.content_hash,
        scope.ownerUserId,
        scope.subjectId,
        context.spaces,
      ],
    );
    const visible = Array.from({ length: source.content.length }, () => ' ');
    let supported = false;
    for (const proof of authorized.rows) {
      const start = proof.quote_start;
      const end = proof.quote_end;
      if (
        start === null ||
        end === null ||
        start < 0 ||
        end <= start ||
        visibleContent.slice(start, end) !== proof.quote
      )
        continue;
      supported = true;
      for (let i = start; i < end; i++) visible[i] = visibleContent[i];
    }
    if (!supported) return null;
    visibleContent = visible.join('');
  } else if (source.subject_id !== scope.subjectId) {
    if (source.subject_kind !== 'unresolved' || !owner) return null;
    // Unattributed history is shown only in conversations about the same client (or none).
    const { rows } = await db.query<{ client_id: string | null }>(
      'SELECT client_id FROM chat_sessions WHERE id=$1',
      [source.session_id],
    );
    if (!rows[0] || rows[0].client_id !== subjectClientId(scope.subjectId))
      return null;
  }
  const window = page(reference, source.content.length);
  if (!window) return null;
  const { offset, limit } = window;
  const text = visibleContent.slice(offset, offset + limit);
  if (!text.trim()) return null;
  const speakerId = frozen?.speakerSubjectId;
  const speaker = speakerId
    ? await db.query<{ name: string }>(
        'SELECT name FROM memory_entities WHERE id=$1 AND owner_user_id=$2',
        [speakerId, scope.ownerUserId],
      )
    : null;
  const speakerName = speaker?.rows[0]?.name ?? '档案身份未确认的说话人';
  return {
    reference,
    text,
    label: `原话 ${offset}-${Math.min(offset + limit, source.content.length)}/${source.content.length}；发言者=${speakerName}；讨论对象=${source.subject_name}；原话为当时陈述，当前值以有效记忆为准${source.subject_kind === 'unresolved' ? '；历史主体未确认，不得当作用户本人的事实' : ''}`,
    ...(offset + limit < source.content.length
      ? { nextReference: { ...reference, offset: offset + limit, limit } }
      : {}),
    observedAt: isoDate(source.observed_at),
    ...(!restrictedProof
      ? {
          sourceMessageId: source.message_id ?? undefined,
          sourceSessionId: source.session_id ?? undefined,
        }
      : {}),
  };
}

interface Candidate {
  reference: MemoryReference;
  automatic: boolean;
  /** Display position; the token budget is spent in array order. */
  order: number;
}

async function hydrateCandidates(
  context: RecallContext,
  candidates: Candidate[],
): Promise<MemoryHydration> {
  const selected: Array<{ excerpt: MemoryExcerpt; order: number }> = [];
  const seen = new Set<string>();
  let used = 0;
  let partial = false;
  for (const candidate of candidates) {
    context.signal?.throwIfAborted();
    const { reference } = candidate;
    const key = `${reference.kind}:${reference.id}:${reference.revision}:${reference.offset ?? 0}:${reference.limit ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const excerpt =
      reference.kind === 'item'
        ? await hydrateItem(context, reference)
        : await hydrateSource(context, reference);
    if (!excerpt) {
      partial = true;
      continue;
    }
    if (candidate.automatic) excerpt.automatic = true;
    const cost = estimateMemoryTokens(JSON.stringify(excerpt));
    if (used + cost > context.policy.recall_token_budget) {
      // Candidates are in priority order; hydrating the rest would only cost queries.
      partial = true;
      break;
    }
    used += cost;
    selected.push({ excerpt, order: candidate.order });
  }
  return memoryHydration(
    context.scope,
    context.policy,
    partial ? 'partial' : 'ready',
    selected.sort((a, b) => a.order - b.order).map((entry) => entry.excerpt),
  );
}

/** Core is rendered from active facts at read time; nothing derived is stored. */
async function coreReferences(
  context: RecallContext,
): Promise<MemoryReference[]> {
  const { rows } = await context.db.query<{ id: string; revision: number }>(
    `SELECT id,revision FROM memory_items WHERE owner_user_id=$1 AND scope_id=ANY($2::text[]) AND subject_id=$3
       AND status='active' AND assertion_type<>'inferred' AND epoch=$4
     -- Intake facts such as the birth date are usually the oldest; ordering by recency alone
     -- would push them out first.
     ORDER BY fact_key=ANY($6::text[]) IS NOT TRUE,
       array_position(ARRAY['fact','preference','decision','plan','event'],kind),observed_at DESC,id
     LIMIT $5`,
    [
      context.scope.ownerUserId,
      context.spaces,
      context.scope.subjectId,
      context.scope.epoch,
      context.policy.recall_max_results * 4,
      MEMORY_PINNED_FACT_KEYS,
    ],
  );
  return rows.map((row) => ({
    kind: 'item',
    id: row.id,
    revision: row.revision,
  }));
}

/** Accepted statements whose extraction has not finished are still recallable. */
async function recentSourceReferences(
  context: RecallContext,
  sessionId: string,
): Promise<MemoryReference[]> {
  const { rows } = await context.db.query<{ id: string; revision: number }>(
    `SELECT s.id,s.revision FROM memory_sources s WHERE s.scope_id=$1 AND s.subject_id=$2
       AND s.epoch=$3 AND s.learning_enabled AND s.excluded_at IS NULL AND s.source_role='user'
       AND s.extracted_revision<s.revision AND s.session_id IS DISTINCT FROM $5
     ORDER BY s.source_sequence DESC LIMIT $4`,
    [
      context.scope.scopeId,
      context.scope.subjectId,
      context.scope.epoch,
      context.policy.recent_source_limit,
      sessionId,
    ],
  );
  return rows.map((row) => ({
    kind: 'source',
    id: row.id,
    revision: row.revision,
    offset: 0,
    limit: 400,
  }));
}

export async function prepareMemory(
  context: RecallContext,
  args: { query?: string; references: MemoryReference[]; sessionId: string },
): Promise<MemoryHydration> {
  const recall = args.query?.trim()
    ? await keywordRecall(context, {
        query: args.query,
        excludeSessionId: args.sessionId,
      })
    : [];
  const core = await coreReferences(context);
  const recent = await recentSourceReferences(context, args.sessionId);
  // The runtime sends prior references oldest first; over the cap, the oldest are dropped.
  const cap = context.policy.recall_max_results * 3;
  const supplied = args.references.slice(-cap);
  const coreCandidates = core.map((reference, index) => ({
    reference,
    automatic: true,
    order: index,
  }));
  // The first core facts are always shown; query recall then wins over the remaining core.
  const coreFirst = context.policy.recall_max_results;
  const candidates: Candidate[] = [
    ...coreCandidates.slice(0, coreFirst),
    ...recall.map((reference, index) => ({
      reference,
      automatic: true,
      order: 3_000_000 + index,
    })),
    ...recent.map((reference, index) => ({
      reference,
      automatic: true,
      order: 1_000_000 + index,
    })),
    ...supplied
      .map((reference, index) => ({
        reference,
        automatic: false,
        order: 2_000_000 + index,
      }))
      .reverse(),
    ...coreCandidates.slice(coreFirst),
  ];
  return hydrateCandidates(context, candidates);
}

export async function searchMemory(
  context: RecallContext,
  args: {
    query: string;
    subjectId?: string;
    after?: string;
    before?: string;
    limit?: number;
  },
  sessionId: string,
): Promise<MemoryHydration> {
  const references = await keywordRecall(context, {
    ...args,
    excludeSessionId: sessionId,
  });
  return hydrateCandidates(
    context,
    references.map((reference, order) => ({
      reference,
      automatic: false,
      order,
    })),
  );
}

export async function readMemory(
  context: RecallContext,
  references: MemoryReference[],
): Promise<MemoryHydration> {
  return hydrateCandidates(
    context,
    references.map((reference, order) => ({
      reference,
      automatic: false,
      order,
    })),
  );
}
