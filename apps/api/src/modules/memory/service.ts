import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type {
  MemoryIpcRequest,
  MemoryResult,
} from '@fateclaw/contracts/agent/memory';
import type {
  MemoryEvidenceDto,
  MemoryItemDto,
  MemoryJobDto,
  MemoryKind,
  MemoryListDto,
  MemoryRequestScope,
  MemorySettingsDto,
  MemoryStatusDto,
} from '@fateclaw/contracts/memory';
import { getDbPool, type DbQueryable } from '#infrastructure/db-pool';
import { logger } from '#infrastructure/logger';
import {
  MemoryError,
  assertMemoryScopeCurrent,
  escapeMemoryLike,
  isoDate,
  memoryHash,
  validateMemoryContent,
  type MemoryItemRow,
  type MemoryJobRow,
} from './domain.js';
import {
  assertMemorySubject,
  ensureOwnerMemoryScope,
  getCurrentMemorySource,
  insertMemoryItem,
  indexMemoryText,
  hasOwnerMemoryAudience,
  assertMemoryBindingCurrent,
  memorySpaceId,
  lockMemoryRoot,
  memoryItemDto,
  memorySettingsDto,
  revokeMemorySource,
  withMemoryReadTransaction,
  withMemoryTransaction,
} from './repository.js';
import { getMemoryRuntimePolicy } from './policy.js';
import {
  authorizeMemoryRecall,
  memoryHydration,
  prepareMemory,
  readMemory,
  searchMemory,
} from './retrieval.js';

export async function ownerMemorySnapshot(
  ownerUserId: string,
  subjectId?: string,
  db: DbQueryable = getDbPool(),
): Promise<MemoryRequestScope> {
  const root = await ensureOwnerMemoryScope(ownerUserId, db);
  const id = subjectId ?? `self:${ownerUserId}`;
  if (id.startsWith('client:'))
    await db.query(
      `INSERT INTO memory_entities(id,owner_user_id,scope_id,kind,client_id,name)
     SELECT 'client:'||id,user_id,$3,'client',id,name FROM client_profiles WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
     ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name WHERE memory_entities.owner_user_id=EXCLUDED.owner_user_id AND memory_entities.deleted_at IS NULL`,
      [id.slice('client:'.length), ownerUserId, root.id],
    );
  const entity = await db.query<{ id: string }>(
    'SELECT id FROM memory_entities WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL',
    [id, ownerUserId],
  );
  if (!entity.rows[0])
    throw new MemoryError('记忆主体不存在', 404, 'MEMORY.SUBJECT_MISSING');
  return {
    scopeId: root.id,
    ownerUserId,
    actorKey: root.actor_key,
    audienceKey: root.audience_key,
    subjectId: id,
    epoch: root.epoch,
    learningEnabled: root.learning_enabled,
    recallEnabled: root.recall_enabled,
    chatEditingEnabled: root.chat_editing_enabled,
    contextGeneration: 0,
    speakerSubjectId: `self:${ownerUserId}`,
    bindingRevision: root.binding_revision ?? 1,
    ownerMemoryAccess: true,
    ownerAudience: true,
    memorySpaceId: root.id,
  };
}

export async function getMemorySettings(
  ownerUserId: string,
): Promise<MemorySettingsDto> {
  return memorySettingsDto(await ensureOwnerMemoryScope(ownerUserId));
}

export async function updateMemorySettings(
  ownerUserId: string,
  input: Partial<MemorySettingsDto> & { revision: number },
): Promise<MemorySettingsDto> {
  return withMemoryTransaction(async (db) => {
    const root = await ensureOwnerMemoryScope(ownerUserId, db);
    const locked = await lockMemoryRoot(root.id, db);
    if (locked.revision !== input.revision)
      throw new MemoryError(
        '记忆设置已变化，请刷新后重试',
        409,
        'MEMORY.CONFLICT',
      );
    const learning = input.learning_enabled ?? locked.learning_enabled;
    const recall = input.recall_enabled ?? locked.recall_enabled;
    const editing = input.chat_editing_enabled ?? locked.chat_editing_enabled;
    if (
      typeof learning !== 'boolean' ||
      typeof recall !== 'boolean' ||
      typeof editing !== 'boolean'
    )
      throw new MemoryError('记忆开关格式错误');
    const { rows } = await db.query<import('./domain.js').MemoryScopeRow>(
      `UPDATE memory_scopes SET learning_enabled=$2,recall_enabled=$3,chat_editing_enabled=$4,
       revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
      [root.id, learning, recall, editing],
    );
    // Apply re-reads the switch under this lock; cancelling here also clears in-flight leases.
    if (!learning && locked.learning_enabled)
      await db.query(
        `UPDATE memory_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL,error_code='LEARNING_CHANGED',updated_at=clock_timestamp()
         WHERE owner_user_id=$1 AND state IN ('pending','running','paused')`,
        [ownerUserId],
      );
    return memorySettingsDto(rows[0]);
  });
}

export async function listMemory(
  ownerUserId: string,
  args: {
    q?: string;
    subjectId?: string;
    scopeId?: string;
    status?: string;
    kind?: string;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<MemoryListDto> {
  const root = await ensureOwnerMemoryScope(ownerUserId);
  const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
  let cursor: { id: string; at: string } | null = null;
  if (args.cursor) {
    try {
      const parsed = JSON.parse(
        Buffer.from(args.cursor, 'base64url').toString(),
      ) as { id?: unknown; at?: unknown };
      if (
        typeof parsed.id === 'string' &&
        typeof parsed.at === 'string' &&
        Number.isFinite(Date.parse(parsed.at))
      )
        cursor = { id: parsed.id, at: parsed.at };
      else throw new Error('Invalid cursor');
    } catch {
      throw new MemoryError('记忆分页参数无效');
    }
  }
  const status = args.status ?? 'active';
  if (
    !['active', 'superseded', 'disputed', 'forgotten', 'all'].includes(status)
  )
    throw new MemoryError('记忆状态无效');
  const { rows } = await getDbPool().query<
    MemoryItemRow & { cursor_at: string }
  >(
    `SELECT i.*,i.updated_at::text AS cursor_at FROM memory_items i JOIN memory_entities e ON e.id=i.subject_id
     LEFT JOIN client_profiles c ON c.id=e.client_id WHERE i.owner_user_id=$1
      AND ($2::text IS NULL OR i.subject_id=$2) AND ($3='all' OR i.status=$3)
      AND ($4::text IS NULL OR i.kind=$4) AND ($5::text IS NULL OR i.content ILIKE $5)
      AND ($6::text IS NULL OR (i.updated_at,i.id)<($9::timestamptz,$6::text)) AND e.deleted_at IS NULL AND (e.client_id IS NULL OR c.deleted_at IS NULL)
      AND ($8::text IS NULL OR EXISTS(SELECT 1 FROM memory_evidence proof JOIN memory_sources origin ON origin.id=proof.source_id WHERE proof.item_id=i.id AND origin.scope_id=$8 AND proof.revoked_at IS NULL))
     ORDER BY i.updated_at DESC,i.id DESC LIMIT $7`,
    [
      ownerUserId,
      args.subjectId ?? null,
      status,
      args.kind ?? null,
      args.q ? `%${escapeMemoryLike(args.q)}%` : null,
      cursor?.id ?? null,
      limit + 1,
      args.scopeId ?? null,
      cursor?.at ?? null,
    ],
  );
  const subjects = await getDbPool().query<{
    id: string;
    kind: 'self' | 'client' | 'sender' | 'unresolved';
    name: string;
  }>(
    `SELECT e.id,e.kind,e.name FROM memory_entities e LEFT JOIN client_profiles c ON c.id=e.client_id WHERE e.owner_user_id=$1 AND e.deleted_at IS NULL AND (e.client_id IS NULL OR c.deleted_at IS NULL)
     UNION ALL SELECT 'client:'||c.id,'client',c.name FROM client_profiles c WHERE c.user_id=$1 AND c.deleted_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM memory_entities e WHERE e.id='client:'||c.id) ORDER BY kind,name`,
    [ownerUserId],
  );
  const selected = rows.slice(0, limit);
  return {
    items: await Promise.all(selected.map((item) => memoryItemDto(item))),
    subjects: subjects.rows,
    next_cursor:
      rows.length > limit
        ? Buffer.from(
            JSON.stringify({
              id: selected.at(-1)!.id,
              at: selected.at(-1)!.cursor_at,
            }),
          ).toString('base64url')
        : null,
    settings: memorySettingsDto(root),
  };
}

async function addManualSource(
  db: pg.PoolClient,
  scope: MemoryRequestScope,
  content: string,
) {
  const id = randomUUID();
  const { rows } = await db.query<import('./domain.js').MemorySourceRow>(
    `INSERT INTO memory_sources(id,owner_user_id,scope_id,subject_id,source_kind,source_role,source_ref,manual_content,
      content_hash,observed_at,epoch,learning_enabled,memory_space_id,identity_snapshot)
     VALUES($1,$2,$3,$4,'manual','manual',$1,$5,$6,clock_timestamp(),$7,false,$8,$9) RETURNING *`,
    [
      id,
      scope.ownerUserId,
      scope.scopeId,
      scope.subjectId,
      content,
      memoryHash(content),
      scope.epoch,
      memorySpaceId(scope),
      JSON.stringify(scope),
    ],
  );
  return rows[0];
}

export async function createManualMemory(
  ownerUserId: string,
  input: { content: string; kind?: MemoryKind; subject_id?: string },
): Promise<MemoryItemDto> {
  const content = validateMemoryContent(input.content);
  return withMemoryTransaction(async (db) => {
    const scope = await ownerMemorySnapshot(ownerUserId, input.subject_id, db);
    // Dashboard edits are direct user actions, independent of conversation tool permission.
    await lockMemoryRoot(scope.scopeId, db);
    const source = await addManualSource(db, scope, content);
    const item = await insertMemoryItem(db, {
      scope,
      content,
      kind: input.kind,
      origin: 'manual',
      source,
      quote: content,
    });
    return memoryItemDto(item, db);
  });
}

export async function editMemoryItem(
  db: pg.PoolClient,
  scope: MemoryRequestScope,
  id: string,
  revision: number,
  content: string,
  origin: 'manual' | 'explicit',
): Promise<MemoryItemRow> {
  const root = await lockMemoryRoot(scope.scopeId, db);
  if (root.epoch !== scope.epoch)
    throw new MemoryError('记忆已变化，请刷新后重试', 409, 'MEMORY.CONFLICT');
  const { rows } = await db.query<MemoryItemRow>(
    "SELECT * FROM memory_items WHERE id=$1 AND owner_user_id=$2 AND revision=$3 AND status='active' FOR UPDATE",
    [id, scope.ownerUserId, revision],
  );
  const previous = rows[0];
  if (!previous)
    throw new MemoryError(
      '记忆已被更新或遗忘，请刷新后重试',
      409,
      'MEMORY.CONFLICT',
    );
  if (
    origin === 'explicit' &&
    previous.scope_id !== memorySpaceId(scope) &&
    !hasOwnerMemoryAudience(scope)
  )
    throw new MemoryError(
      '此说话人只能修改自己的记忆',
      403,
      'MEMORY.SPACE_DENIED',
    );
  const actualScope = {
    ...scope,
    memorySpaceId: previous.scope_id,
    subjectId: previous.subject_id,
  };
  if (origin === 'explicit')
    await assertMemorySubject(scope, previous.subject_id, db);
  const source = await addManualSource(db, actualScope, content);
  return insertMemoryItem(db, {
    scope: actualScope,
    content,
    kind: previous.kind,
    factKey: previous.fact_key,
    origin,
    source,
    quote: content,
    supersedesId: previous.id,
  });
}

export async function updateManualMemory(
  ownerUserId: string,
  id: string,
  input: { content: string; revision: number },
): Promise<MemoryItemDto> {
  const content = validateMemoryContent(input.content);
  return withMemoryTransaction(async (db) => {
    const scope = await ownerMemorySnapshot(ownerUserId, undefined, db);
    await lockMemoryRoot(scope.scopeId, db);
    return memoryItemDto(
      await editMemoryItem(db, scope, id, input.revision, content, 'manual'),
      db,
    );
  });
}

export async function forgetMemoryItem(
  db: pg.PoolClient,
  ownerUserId: string,
  id: string,
  revision?: number,
): Promise<void> {
  const root = await ensureOwnerMemoryScope(ownerUserId, db);
  await lockMemoryRoot(root.id, db);
  const { rows } = await db.query<MemoryItemRow>(
    'SELECT * FROM memory_items WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',
    [id, ownerUserId],
  );
  const item = rows[0];
  if (!item) throw new MemoryError('记忆不存在', 404, 'MEMORY.NOT_FOUND');
  if (revision !== undefined && item.revision !== revision)
    throw new MemoryError(
      '记忆版本已变化，请刷新后重试',
      409,
      'MEMORY.CONFLICT',
    );
  if (item.status === 'forgotten') return;
  const linked = await db.query<{ family_id: string }>(
    `WITH RECURSIVE families(family_id) AS (
       SELECT $1::text UNION
       SELECT CASE WHEN original.family_id=f.family_id THEN target.family_id ELSE original.family_id END
       FROM families f JOIN memory_items original ON original.owner_user_id=$2 AND original.scope_id=$3 AND original.subject_id=$4
       JOIN memory_items target ON target.id=original.merged_into_id AND target.owner_user_id=$2
         AND target.scope_id=$3 AND target.subject_id=$4
       WHERE original.family_id=f.family_id OR target.family_id=f.family_id
     ) SELECT family_id FROM families`,
    [item.family_id, ownerUserId, item.scope_id, item.subject_id],
  );
  const familyIds = linked.rows.map((row) => row.family_id);
  const evidence = await db.query<{
    source_id: string;
    quote: string;
    quote_start: number | null;
    quote_end: number | null;
    source_ref: string;
    source_hash: string;
  }>(
    `SELECT e.source_id,e.quote,e.quote_start,e.quote_end,s.source_ref,s.content_hash AS source_hash FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id
     WHERE e.item_id IN(SELECT id FROM memory_items WHERE family_id=ANY($1::text[])) AND e.revoked_at IS NULL`,
    [familyIds],
  );
  const sequence = await db.query<{ cutoff: string }>(
    'SELECT COALESCE(max(source_sequence),0)::text AS cutoff FROM memory_sources WHERE owner_user_id=$1',
    [ownerUserId],
  );
  await db.query(
    `INSERT INTO memory_exclusions(owner_user_id,scope_id,subject_id,family_id,fact_key,content_hash,cutoff_sequence)
     SELECT DISTINCT owner_user_id,scope_id,subject_id,family_id,fact_key,content_hash,$3::bigint
     FROM memory_items WHERE owner_user_id=$1 AND family_id=ANY($2::text[])`,
    [ownerUserId, familyIds, sequence.rows[0].cutoff],
  );
  for (const proof of evidence.rows) {
    const source = await getCurrentMemorySource(proof.source_id, db);
    const ranges: Array<{ start: number; end: number }> = [];
    if (source && proof.quote) {
      for (
        let offset = source.content.indexOf(proof.quote);
        offset >= 0;
        offset = source.content.indexOf(proof.quote, offset + 1)
      )
        ranges.push({ start: offset, end: offset + proof.quote.length });
    }
    if (
      !ranges.length &&
      proof.quote_start !== null &&
      proof.quote_end !== null
    )
      ranges.push({ start: proof.quote_start, end: proof.quote_end });
    for (const range of ranges)
      await db.query(
        `INSERT INTO memory_exclusions(owner_user_id,scope_id,subject_id,source_id,source_ref,source_hash,family_id,content_hash,quote_start,quote_end,cutoff_sequence,reason)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'forgotten_fact')`,
        [
          ownerUserId,
          item.scope_id,
          item.subject_id,
          proof.source_id,
          proof.source_ref,
          proof.source_hash,
          item.family_id,
          item.content_hash,
          range.start,
          range.end,
          sequence.rows[0].cutoff,
        ],
      );
  }
  const changed = await db.query<{ id: string }>(
    "UPDATE memory_items SET status='forgotten',content='[已遗忘]',updated_at=clock_timestamp() WHERE family_id=ANY($1::text[]) RETURNING id",
    [familyIds],
  );
  await db.query(
    "UPDATE memory_evidence SET revoked_at=clock_timestamp(),quote='' WHERE item_id=ANY($1::text[])",
    [changed.rows.map((r) => r.id)],
  );
  await db.query(
    "DELETE FROM memory_index_entries WHERE object_kind='item' AND object_id=ANY($1::text[])",
    [changed.rows.map((r) => r.id)],
  );
  const overlapping = await db.query<{ item_id: string }>(
    `UPDATE memory_evidence e SET revoked_at=clock_timestamp(),quote='' WHERE e.revoked_at IS NULL
     AND EXISTS(SELECT 1 FROM memory_exclusions x WHERE x.owner_user_id=$1 AND x.reason='forgotten_fact' AND x.family_id=$2
       AND x.source_id=e.source_id AND e.quote_start<x.quote_end AND e.quote_end>x.quote_start) RETURNING e.item_id`,
    [ownerUserId, item.family_id],
  );
  if (overlapping.rows.length) {
    await db.query(
      `UPDATE memory_items i SET status='forgotten',content='[来源已撤销]',updated_at=clock_timestamp()
      WHERE i.id=ANY($1::text[]) AND NOT EXISTS(SELECT 1 FROM memory_evidence e WHERE e.item_id=i.id AND e.revoked_at IS NULL)`,
      [overlapping.rows.map((row) => row.item_id)],
    );
    await db.query(
      "DELETE FROM memory_index_entries x WHERE object_kind='item' AND object_id=ANY($1::text[]) AND EXISTS(SELECT 1 FROM memory_items i WHERE i.id=x.object_id AND i.status='forgotten')",
      [overlapping.rows.map((row) => row.item_id)],
    );
  }
  for (const proof of evidence.rows) {
    // Reindex from the masked projection so the forgotten quote stops matching keyword search.
    await db.query(
      "DELETE FROM memory_index_entries WHERE object_kind='source' AND object_id=$1",
      [proof.source_id],
    );
    const source = await getCurrentMemorySource(proof.source_id, db);
    if (source)
      await indexMemoryText(db, {
        ownerUserId,
        scopeId: source.memory_space_id ?? source.scope_id,
        subjectId: source.subject_id,
        kind: 'source',
        id: source.id,
        revision: source.revision,
        text: source.content,
      });
  }
}

export async function forgetManualMemory(
  ownerUserId: string,
  id: string,
  revision?: number,
): Promise<void> {
  await withMemoryTransaction((db) =>
    forgetMemoryItem(db, ownerUserId, id, revision),
  );
}

export async function getMemoryEvidence(
  ownerUserId: string,
  itemId: string,
): Promise<{ evidence: MemoryEvidenceDto[] }> {
  const exists = await getDbPool().query(
    'SELECT 1 FROM memory_items WHERE id=$1 AND owner_user_id=$2',
    [itemId, ownerUserId],
  );
  if (!exists.rows[0])
    throw new MemoryError('记忆不存在', 404, 'MEMORY.NOT_FOUND');
  const { rows } = await getDbPool().query<{
    id: string;
    source_id: string;
    source_revision: number;
    source_hash: string;
    quote: string;
    session_id: string | null;
    message_id: string | null;
    scope_id: string;
    scope_name: string;
    source_role: MemoryEvidenceDto['source_role'];
    observed_at: Date | string;
    excluded_at: Date | string | null;
  }>(
    `SELECT e.id,e.source_id,e.source_revision,e.source_hash,e.quote,s.session_id,s.message_id,s.source_role,s.observed_at,s.excluded_at,s.scope_id,
       COALESCE(sc.display_name,CASE WHEN sc.parent_scope_id IS NULL THEN '网页对话' ELSE '微信联系人' END) AS scope_name
     FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id JOIN memory_scopes sc ON sc.id=s.scope_id
     WHERE e.item_id=$1 AND e.revoked_at IS NULL ORDER BY s.observed_at DESC`,
    [itemId],
  );
  const evidence: MemoryEvidenceDto[] = [];
  for (const row of rows) {
    const current = await getCurrentMemorySource(row.source_id);
    const available = Boolean(
      current &&
      current.revision === row.source_revision &&
      current.content_hash === row.source_hash &&
      current.content.includes(row.quote),
    );
    evidence.push({
      id: row.id,
      source_id: row.source_id,
      source_revision: row.source_revision,
      session_id: row.session_id,
      message_id: row.message_id,
      source_role: row.source_role,
      quote: available ? row.quote : '[来源已变化或撤销]',
      observed_at: isoDate(row.observed_at),
      source_available: available,
      scope_id: row.scope_id,
      scope_name: row.scope_name,
    });
  }
  return { evidence };
}

export async function excludeMemorySource(
  ownerUserId: string,
  sourceId: string,
): Promise<void> {
  await withMemoryTransaction(async (db) => {
    const root = await ensureOwnerMemoryScope(ownerUserId, db);
    await lockMemoryRoot(root.id, db);
    const { rows } = await db.query<{
      scope_id: string;
      subject_id: string;
      source_sequence: string;
      source_ref: string;
      content_hash: string;
    }>(
      'SELECT scope_id,subject_id,source_sequence,source_ref,content_hash FROM memory_sources WHERE id=$1 AND owner_user_id=$2',
      [sourceId, ownerUserId],
    );
    if (!rows[0])
      throw new MemoryError('记忆来源不存在', 404, 'MEMORY.SOURCE_MISSING');
    await db.query(
      "INSERT INTO memory_exclusions(owner_user_id,scope_id,subject_id,source_id,source_ref,source_hash,cutoff_sequence,reason) VALUES($1,$2,$3,$4,$5,NULL,$6,'source_excluded')",
      [
        ownerUserId,
        rows[0].scope_id,
        rows[0].subject_id,
        sourceId,
        rows[0].source_ref,
        rows[0].source_sequence,
      ],
    );
    await revokeMemorySource(db, sourceId);
  });
}

export async function clearMemory(
  ownerUserId: string,
  resetContext = false,
): Promise<MemorySettingsDto> {
  return withMemoryTransaction(async (db) => {
    const root = await ensureOwnerMemoryScope(ownerUserId, db);
    await lockMemoryRoot(root.id, db);
    const { rows } = await db.query<import('./domain.js').MemoryScopeRow>(
      `UPDATE memory_scopes SET epoch=epoch+1,revision=revision+1,cleared_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE id=$1 RETURNING *`,
      [root.id],
    );
    await db.query(
      "UPDATE memory_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL,error_code='MEMORY_CLEARED' WHERE owner_user_id=$1 AND state IN ('pending','running','paused','failed')",
      [ownerUserId],
    );
    await db.query(
      "UPDATE memory_items SET status='forgotten',content='[已遗忘]' WHERE owner_user_id=$1",
      [ownerUserId],
    );
    await db.query(
      "UPDATE memory_evidence SET revoked_at=clock_timestamp(),quote='' WHERE item_id IN(SELECT id FROM memory_items WHERE owner_user_id=$1)",
      [ownerUserId],
    );
    await db.query(
      'UPDATE memory_sources SET excluded_at=clock_timestamp(),manual_content=NULL WHERE owner_user_id=$1',
      [ownerUserId],
    );
    await db.query('DELETE FROM memory_index_entries WHERE owner_user_id=$1', [
      ownerUserId,
    ]);
    if (resetContext) {
      await db.query(
        'UPDATE chat_sessions SET memory_context_generation=memory_context_generation+1 WHERE user_id=$1',
        [ownerUserId],
      );
      await db.query(
        "UPDATE agent_requests SET cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()) WHERE owner_user_id=$1 AND state IN ('queued','dispatched','running')",
        [ownerUserId],
      );
    }
    return memorySettingsDto(rows[0]);
  });
}

async function activeRequest(
  accountId: string,
  request: MemoryIpcRequest,
  db: DbQueryable = getDbPool(),
  lock = false,
) {
  const { rows } = await db.query<{
    memory_scope: MemoryRequestScope | null;
    session_id: string;
    user_message_id: string | null;
  }>(
    `SELECT r.memory_scope,r.session_id,r.user_message_id FROM agent_requests r JOIN chat_sessions s ON s.id=r.session_id
     WHERE r.request_id=$1 AND r.account_id=$2 AND r.execution_id=$3 AND r.state='running'
       AND r.cancel_requested_at IS NULL AND r.deadline_at>clock_timestamp() AND s.deleted_at IS NULL
       AND r.owner_user_id=s.user_id AND r.account_id=s.account_id
       AND EXISTS(SELECT 1 FROM pi_session_contexts c WHERE c.session_id=s.id
         AND c.context_audience=COALESCE(r.memory_scope->>'contextAudience','')
         AND c.context_generation=COALESCE((r.memory_scope->>'contextGeneration')::int,0)
         AND c.reset_revision=s.memory_context_generation) ${lock ? 'FOR UPDATE OF r' : ''}`,
    [request.requestId, accountId, request.executionId],
  );
  if (!rows[0]?.memory_scope)
    throw new MemoryError(
      '记忆请求已结束或未获得授权',
      403,
      'MEMORY.REQUEST_INACTIVE',
    );
  await assertMemoryBindingCurrent(rows[0].memory_scope, db);
  return { ...rows[0], scope: rows[0].memory_scope };
}

class MemoryDeadlineError extends Error {}

/** Reads never hold the turn: past the policy deadline the model continues without memory. */
async function readWithinDeadline(
  accountId: string,
  request: MemoryIpcRequest & {
    operation: Extract<
      MemoryIpcRequest['operation'],
      { mode: 'prepare' | 'read' | 'search' }
    >;
  },
): Promise<MemoryResult> {
  const policy = await getMemoryRuntimePolicy();
  const operation = request.operation;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let scope: MemoryRequestScope | undefined;
  const run = withMemoryReadTransaction(
    async (db) => {
      const admitted = await activeRequest(accountId, request, db);
      scope = admitted.scope;
      const context = await authorizeMemoryRecall(
        db,
        admitted.scope,
        policy,
        controller.signal,
      );
      if (!context) return memoryHydration(admitted.scope, policy, 'disabled');
      if (operation.mode === 'prepare')
        return prepareMemory(context, {
          query: operation.query,
          references: operation.references,
          sessionId: admitted.session_id,
        });
      if (operation.mode === 'search') return searchMemory(context, operation);
      return readMemory(context, operation.references);
    },
    { timeoutMs: policy.recall_timeout_ms },
  );
  run.catch(() => undefined);
  try {
    const hydration = await Promise.race([
      run,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new MemoryDeadlineError());
        }, policy.recall_timeout_ms);
      }),
    ]);
    return { ok: true, mode: operation.mode, hydration };
  } catch (error) {
    const timedOut =
      error instanceof MemoryDeadlineError ||
      (error as { code?: string } | null)?.code === '57014';
    if (operation.mode === 'prepare' || timedOut) {
      if (!(error instanceof MemoryError) && !timedOut)
        logger.warn(
          {
            requestId: request.requestId,
            errorType: error instanceof Error ? error.name : 'unknown',
          },
          'Memory recall failed; the turn continues without memory',
        );
      if (!scope)
        throw new MemoryError('记忆暂时不可用', 503, 'MEMORY.UNAVAILABLE');
      return {
        ok: true,
        mode: operation.mode,
        hydration: memoryHydration(scope, policy, 'unavailable'),
      };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function executeMemoryOperation(
  accountId: string,
  request: MemoryIpcRequest,
): Promise<MemoryResult> {
  const operation = request.operation;
  if (
    operation.mode === 'prepare' ||
    operation.mode === 'read' ||
    operation.mode === 'search'
  )
    return readWithinDeadline(accountId, { ...request, operation });
  return withMemoryTransaction<MemoryResult>(async (db) => {
    const admitted = await activeRequest(accountId, request, db);
    const scope = admitted.scope;
    const root = await lockMemoryRoot(scope.scopeId, db);
    await activeRequest(accountId, request, db, true);
    assertMemoryScopeCurrent(scope, root, 'edit');
    const hash = memoryHash(JSON.stringify(operation));
    const prior = await db.query<{
      operation_hash: string;
      result: MemoryResult;
    }>(
      'SELECT operation_hash,result FROM memory_tool_results WHERE request_id=$1 AND tool_call_id=$2',
      [request.requestId, operation.toolCallId],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].operation_hash !== hash)
        throw new MemoryError(
          '工具重试参数已变化',
          409,
          'MEMORY.TOOL_CONFLICT',
        );
      return prior.rows[0].result;
    }
    let result: MemoryResult;
    if (operation.mode === 'remember') {
      const content = validateMemoryContent(operation.content);
      const subjectId = operation.subjectId ?? scope.subjectId;
      await assertMemorySubject(scope, subjectId, db);
      // Evidence must be a user statement this request's audience saw in this session.
      const found = await db.query<{ id: string }>(
        `SELECT id FROM memory_sources WHERE scope_id=$1 AND owner_user_id=$2 AND session_id=$3
           AND message_id=$4 AND source_kind='message' AND source_role='user' AND excluded_at IS NULL
           AND COALESCE(identity_snapshot->>'contextAudience','')=$5
         ORDER BY revision DESC LIMIT 1`,
        [
          scope.scopeId,
          scope.ownerUserId,
          admitted.session_id,
          operation.sourceMessageId ?? admitted.user_message_id,
          scope.contextAudience ?? '',
        ],
      );
      const source = found.rows[0]
        ? await getCurrentMemorySource(found.rows[0].id, db)
        : null;
      if (!source || !source.content.includes(content))
        throw new MemoryError(
          '请忠实保存用户原话，并引用本次已授权的用户消息',
          400,
          'MEMORY.EVIDENCE_REQUIRED',
        );
      const item = await insertMemoryItem(db, {
        scope,
        subjectId,
        content,
        kind: operation.kind,
        origin: 'explicit',
        source,
        quote: content,
      });
      result = {
        ok: true,
        mode: 'remember',
        reference: { kind: 'item', id: item.id, revision: item.revision },
      };
    } else if (operation.mode === 'update') {
      const item = await editMemoryItem(
        db,
        scope,
        operation.id,
        operation.revision,
        validateMemoryContent(operation.content),
        'explicit',
      );
      result = {
        ok: true,
        mode: 'update',
        reference: { kind: 'item', id: item.id, revision: item.revision },
      };
    } else {
      const item = await db.query<{ scope_id: string; subject_id: string }>(
        'SELECT scope_id,subject_id FROM memory_items WHERE id=$1 AND owner_user_id=$2',
        [operation.id, scope.ownerUserId],
      );
      if (
        !item.rows[0] ||
        (item.rows[0].scope_id !== memorySpaceId(scope) &&
          !hasOwnerMemoryAudience(scope))
      )
        throw new MemoryError(
          '记忆不存在或未授权',
          403,
          'MEMORY.AUDIENCE_DENIED',
        );
      await assertMemorySubject(scope, item.rows[0].subject_id, db);
      await forgetMemoryItem(
        db,
        scope.ownerUserId,
        operation.id,
        operation.revision,
      );
      result = { ok: true, mode: 'forget', forgottenId: operation.id };
    }
    await db.query(
      'INSERT INTO memory_tool_results(owner_user_id,scope_id,request_id,tool_call_id,operation_hash,result) VALUES($1,$2,$3,$4,$5,$6)',
      [
        scope.ownerUserId,
        scope.scopeId,
        request.requestId,
        operation.toolCallId,
        hash,
        JSON.stringify(result),
      ],
    );
    return result;
  });
}

export function memoryJobDto(job: MemoryJobRow): MemoryJobDto {
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

export async function memoryStatus(
  ownerUserId?: string,
): Promise<MemoryStatusDto> {
  const db = getDbPool();
  const count = await db.query<{
    pending_jobs: string;
    failed_jobs: string;
    active_items: string;
    indexed_items: string;
  }>(
    `SELECT (SELECT count(*) FROM memory_jobs WHERE ($1::text IS NULL OR owner_user_id=$1) AND state IN ('pending','running'))::text AS pending_jobs,
      (SELECT count(*) FROM memory_jobs WHERE ($1::text IS NULL OR owner_user_id=$1) AND state='failed')::text AS failed_jobs,
      (SELECT count(*) FROM memory_items WHERE ($1::text IS NULL OR owner_user_id=$1) AND status='active')::text AS active_items,
      (SELECT count(DISTINCT object_id) FROM memory_index_entries WHERE ($1::text IS NULL OR owner_user_id=$1) AND object_kind='item')::text AS indexed_items`,
    [ownerUserId ?? null],
  );
  const jobs = await db.query<MemoryJobRow>(
    "SELECT * FROM memory_jobs WHERE ($1::text IS NULL OR owner_user_id=$1) ORDER BY CASE WHEN kind='backfill' AND state IN ('pending','running','paused') THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 20",
    [ownerUserId ?? null],
  );
  const row = count.rows[0];
  return {
    pending_jobs: Number(row.pending_jobs),
    failed_jobs: Number(row.failed_jobs),
    active_items: Number(row.active_items),
    indexed_items: Number(row.indexed_items),
    recent_jobs: jobs.rows.map(memoryJobDto),
  };
}
