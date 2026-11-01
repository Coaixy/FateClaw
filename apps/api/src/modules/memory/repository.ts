import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type {
  MemoryItemDto,
  MemoryKind,
  MemoryRequestScope,
  MemorySettingsDto,
} from '@fateclaw/contracts/memory';
import { getDbPool, type DbQueryable } from '#infrastructure/db-pool';
import { getMemoryRuntimePolicy } from './policy.js';
import { resolveMemoryPiContext } from './pi-contexts.js';
import {
  MemoryError,
  assertMemoryScopeCurrent,
  isoDate,
  memoryContentHash,
  memoryHash,
  memorySourceHasNoStatement,
  memorySourceId,
  validateMemoryContent,
  type MemoryItemRow,
  type MemoryScopeRow,
  type MemorySourceRow,
} from './domain.js';

export async function withMemoryTransaction<T>(
  run: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const db = await getDbPool().connect();
  let discard = false;
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    const result = await run(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    db.release(discard);
  }
}

/** One consistent snapshot without row locks, so recall never waits behind memory writers. */
export async function withMemoryReadTransaction<T>(
  run: (db: pg.PoolClient) => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const db = await getDbPool().connect();
  let discard = false;
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (options.timeoutMs)
      await db.query(
        `SET LOCAL statement_timeout=${Math.max(1, Math.floor(options.timeoutMs))}`,
      );
    const result = await run(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    db.release(discard);
  }
}

export async function ensureOwnerMemoryScope(
  ownerUserId: string,
  db: DbQueryable = getDbPool(),
): Promise<MemoryScopeRow> {
  const policy = await getMemoryRuntimePolicy(db);
  await db.query(
    `INSERT INTO memory_scopes(owner_user_id,actor_key,audience_key,learning_enabled)
     SELECT id,'user:'||id,'owner:'||id,$2 FROM users WHERE id=$1
     ON CONFLICT(owner_user_id,actor_key,audience_key) DO NOTHING`,
    [ownerUserId, policy.default_learning_enabled],
  );
  const { rows } = await db.query<MemoryScopeRow>(
    "SELECT * FROM memory_scopes WHERE owner_user_id=$1 AND actor_key='user:'||$1 AND parent_scope_id IS NULL",
    [ownerUserId],
  );
  if (!rows[0]) throw new MemoryError('用户不存在', 404, 'MEMORY.USER_MISSING');
  const root = rows[0];
  await db.query(
    "INSERT INTO memory_entities(id,owner_user_id,scope_id,kind,name) VALUES($1,$2,$3,'self','用户本人') ON CONFLICT(id) DO NOTHING",
    [`self:${ownerUserId}`, ownerUserId, root.id],
  );
  return root;
}

/**
 * Serializes memory writers. NO KEY UPDATE, because FOR UPDATE also blocks the foreign-key checks
 * of chat admission inserting sources and jobs that reference the scope.
 */
export async function lockMemoryRoot(
  scopeId: string,
  db: pg.PoolClient,
): Promise<MemoryScopeRow> {
  const { rows } = await db.query<MemoryScopeRow>(
    `SELECT root.*,root.cleared_at::text AS cleared_at FROM memory_scopes scoped JOIN memory_scopes root
     ON root.id=COALESCE(scoped.parent_scope_id,scoped.id) WHERE scoped.id=$1 FOR NO KEY UPDATE OF root`,
    [scopeId],
  );
  if (!rows[0])
    throw new MemoryError('记忆范围不存在', 404, 'MEMORY.SCOPE_MISSING');
  return rows[0];
}

export async function readMemoryRoot(
  scopeId: string,
  db: DbQueryable = getDbPool(),
): Promise<MemoryScopeRow> {
  const { rows } = await db.query<MemoryScopeRow>(
    'SELECT root.*,root.cleared_at::text AS cleared_at FROM memory_scopes scoped JOIN memory_scopes root ON root.id=COALESCE(scoped.parent_scope_id,scoped.id) WHERE scoped.id=$1',
    [scopeId],
  );
  if (!rows[0])
    throw new MemoryError('记忆范围不存在', 404, 'MEMORY.SCOPE_MISSING');
  return rows[0];
}

export function memorySettingsDto(root: MemoryScopeRow): MemorySettingsDto {
  return {
    learning_enabled: root.learning_enabled,
    recall_enabled: root.recall_enabled,
    chat_editing_enabled: root.chat_editing_enabled,
    revision: root.revision,
    epoch: root.epoch,
  };
}

/**
 * Freezes the request identity without locking the memory root. Subject or binding problems only
 * disable memory for this turn; apply-time epoch checks reject work admitted before a clear.
 */
export async function createMemoryAdmissionScope(
  db: pg.PoolClient,
  args: {
    ownerUserId: string;
    sessionId: string;
    metadata?: Record<string, unknown> | null;
    learningAllowed?: boolean;
  },
): Promise<MemoryRequestScope> {
  const root = await ensureOwnerMemoryScope(args.ownerUserId, db);
  const { rows: sessions } = await db.query<{
    client_id: string | null;
    memory_learning_enabled: boolean;
  }>(
    'SELECT client_id,memory_learning_enabled FROM chat_sessions WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
    [args.sessionId, args.ownerUserId],
  );
  const session = sessions[0];
  if (!session)
    throw new MemoryError(
      '会话不存在或无权访问',
      404,
      'MEMORY.SESSION_MISSING',
    );
  let scope = root;
  let actorSubject = `self:${args.ownerUserId}`;
  const metadata = args.metadata;
  if (
    metadata?.source_channel === 'wechat' ||
    metadata?.source_channel === 'openapi'
  ) {
    const api = metadata.source_channel === 'openapi';
    if (
      !api &&
      (typeof metadata.wechat_account_id !== 'string' ||
        typeof metadata.sender_hash !== 'string')
    )
      throw new MemoryError(
        '微信说话人身份不完整',
        403,
        'MEMORY.ACTOR_MISSING',
      );
    if (api && typeof metadata.api_key_id !== 'string')
      throw new MemoryError(
        'API 调用方身份不完整',
        403,
        'MEMORY.ACTOR_MISSING',
      );
    const actorKey = api
      ? `openapi:${metadata.api_key_id}`
      : `wechat:${metadata.wechat_account_id}:${metadata.sender_hash}`;
    const audienceKey = `sender:${memoryHash(actorKey)}`;
    await db.query(
      `INSERT INTO memory_scopes(owner_user_id,parent_scope_id,actor_key,audience_key)
       VALUES($1,$2,$3,$4) ON CONFLICT(owner_user_id,actor_key,audience_key) DO NOTHING`,
      [args.ownerUserId, root.id, actorKey, audienceKey],
    );
    const found = await db.query<MemoryScopeRow>(
      'SELECT * FROM memory_scopes WHERE owner_user_id=$1 AND actor_key=$2 AND audience_key=$3',
      [args.ownerUserId, actorKey, audienceKey],
    );
    scope = found.rows[0];
    actorSubject = `sender:${memoryHash(actorKey)}`;
    await db.query(
      "INSERT INTO memory_entities(id,owner_user_id,scope_id,kind,name) VALUES($1,$2,$3,'sender',$4) ON CONFLICT(id) DO NOTHING",
      [
        actorSubject,
        args.ownerUserId,
        scope.id,
        api ? 'API 调用方' : '微信联系人',
      ],
    );
  }
  let memoryAvailable = true;
  let speakerSubjectId = actorSubject;
  let subjectId = actorSubject;
  if (scope.bound_subject_id) {
    const binding = await db.query<{ kind: string; client_id: string | null }>(
      `SELECT e.kind,e.client_id FROM memory_entities e LEFT JOIN client_profiles c ON c.id=e.client_id
       WHERE e.id=$1 AND e.owner_user_id=$2 AND e.deleted_at IS NULL AND (e.client_id IS NULL OR c.deleted_at IS NULL)`,
      [scope.bound_subject_id, args.ownerUserId],
    );
    const bound = binding.rows[0];
    if (!bound) memoryAvailable = false;
    else {
      speakerSubjectId = scope.bound_subject_id;
      subjectId = scope.bound_subject_id;
      if (
        bound.kind === 'client' &&
        session.client_id &&
        bound.client_id !== session.client_id
      )
        memoryAvailable = false;
    }
  }
  if (session.client_id) {
    subjectId = `client:${session.client_id}`;
    const client = await db.query<{ id: string; name: string }>(
      'SELECT id,name FROM client_profiles WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
      [session.client_id, args.ownerUserId],
    );
    if (!client.rows[0]) memoryAvailable = false;
    else
      await db.query(
        `INSERT INTO memory_entities(id,owner_user_id,scope_id,kind,client_id,name)
         VALUES($1,$2,$3,'client',$4,$5) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name`,
        [
          subjectId,
          args.ownerUserId,
          root.id,
          client.rows[0].id,
          client.rows[0].name,
        ],
      );
  }
  const ownerAudience =
    scope.actor_key === `user:${args.ownerUserId}` ||
    Boolean(
      speakerSubjectId === `self:${args.ownerUserId}` &&
      scope.share_subject_memory,
    );
  const contextAudience =
    metadata?.source_channel === 'openapi'
      ? ''
      : ownerAudience
        ? args.sessionId.startsWith('openapi:')
          ? `owner:${args.ownerUserId}`
          : ''
        : scope.audience_key;
  const piContext = await resolveMemoryPiContext(db, {
    sessionId: args.sessionId,
    ownerUserId: args.ownerUserId,
    audience: contextAudience,
  });
  return {
    scopeId: scope.id,
    ownerUserId: args.ownerUserId,
    actorKey: scope.actor_key,
    audienceKey: scope.audience_key,
    subjectId,
    epoch: root.epoch,
    learningEnabled:
      memoryAvailable &&
      root.learning_enabled &&
      session.memory_learning_enabled !== false &&
      args.learningAllowed !== false,
    recallEnabled: memoryAvailable && root.recall_enabled,
    chatEditingEnabled: memoryAvailable && root.chat_editing_enabled,
    contextGeneration: piContext.contextGeneration,
    contextAudience,
    memorySpaceId: ownerAudience ? root.id : scope.id,
    speakerSubjectId,
    bindingRevision: scope.binding_revision ?? 1,
    ownerMemoryAccess:
      scope.actor_key === `user:${args.ownerUserId}` ||
      Boolean(speakerSubjectId !== actorSubject && scope.share_subject_memory),
    ownerAudience,
  };
}

export async function prepareMemoryAdmissionScope(
  args: Parameters<typeof createMemoryAdmissionScope>[1],
): Promise<MemoryRequestScope> {
  return withMemoryTransaction((db) => createMemoryAdmissionScope(db, args));
}

export function actorSubjectId(scope: MemoryRequestScope): string {
  return (
    scope.speakerSubjectId ??
    (scope.actorKey.startsWith('user:')
      ? `self:${scope.ownerUserId}`
      : `sender:${memoryHash(scope.actorKey)}`)
  );
}

export function memorySpaceId(scope: MemoryRequestScope): string {
  return scope.memorySpaceId ?? scope.scopeId;
}

export function hasOwnerMemoryAudience(scope: MemoryRequestScope): boolean {
  return (
    scope.ownerAudience === true ||
    scope.actorKey === `user:${scope.ownerUserId}` ||
    (scope.ownerMemoryAccess === true &&
      actorSubjectId(scope) === `self:${scope.ownerUserId}`)
  );
}

/** Shared reads name exactly the canonical root and the request's own space. */
export async function readableMemorySpaces(
  scope: MemoryRequestScope,
  db: DbQueryable,
): Promise<string[]> {
  const own = memorySpaceId(scope);
  const shared =
    hasOwnerMemoryAudience(scope) ||
    (scope.ownerMemoryAccess === true &&
      scope.subjectId === actorSubjectId(scope));
  if (!shared) return [own];
  const { rows } = await db.query<{ root_id: string }>(
    'SELECT COALESCE(parent_scope_id,id) AS root_id FROM memory_scopes WHERE id=$1 AND owner_user_id=$2',
    [scope.scopeId, scope.ownerUserId],
  );
  return [...new Set([rows[0]?.root_id ?? own, own])];
}

export async function assertMemoryBindingCurrent(
  scope: MemoryRequestScope,
  db: DbQueryable = getDbPool(),
): Promise<void> {
  const { rows } = await db.query<{
    binding_revision: number;
    actor_key: string;
    audience_key: string;
  }>(
    'SELECT binding_revision,actor_key,audience_key FROM memory_scopes WHERE id=$1 AND owner_user_id=$2',
    [scope.scopeId, scope.ownerUserId],
  );
  if (
    !rows[0] ||
    rows[0].binding_revision !== (scope.bindingRevision ?? 1) ||
    rows[0].actor_key !== scope.actorKey ||
    rows[0].audience_key !== scope.audienceKey
  )
    throw new MemoryError(
      '说话人绑定已变化，请重新发送消息',
      409,
      'MEMORY.BINDING_CHANGED',
    );
}

export async function assertMemorySubject(
  scope: MemoryRequestScope,
  subjectId: string,
  db: DbQueryable = getDbPool(),
): Promise<void> {
  if (subjectId !== scope.subjectId && subjectId !== actorSubjectId(scope))
    throw new MemoryError(
      '本次请求未授权该记忆主体',
      403,
      'MEMORY.SUBJECT_DENIED',
    );
  const { rows } = await db.query(
    `SELECT e.id FROM memory_entities e LEFT JOIN client_profiles c ON c.id=e.client_id
     WHERE e.id=$1 AND e.owner_user_id=$2 AND e.deleted_at IS NULL
       AND (e.client_id IS NULL OR c.deleted_at IS NULL AND c.user_id=$2)`,
    [subjectId, scope.ownerUserId],
  );
  if (!rows[0])
    throw new MemoryError(
      '记忆主体不存在或已归档',
      403,
      'MEMORY.SUBJECT_INACTIVE',
    );
}

/**
 * Records an accepted user message and its extraction job. Authorization is deliberately left to
 * job application so admission cannot fail ordinary chat over memory state.
 */
export async function captureMemorySource(
  db: DbQueryable,
  args: {
    scope: MemoryRequestScope;
    requestId: string;
    messageId: string;
    accountId: string;
    sessionId: string;
    content: string;
    observedAt: string;
    backfillJobId?: string;
  },
): Promise<MemorySourceRow | null> {
  const sourceRef = `${args.accountId}:${args.messageId}`;
  const hash = memoryHash(args.content);
  const id = memorySourceId(args.scope.scopeId, sourceRef, hash);
  // Only history import can re-create a message the user already excluded; a new admission cannot.
  const excluded = args.backfillJobId
    ? await db.query(
        "SELECT 1 FROM memory_exclusions WHERE owner_user_id=$1 AND source_ref=$2 AND reason='source_excluded' AND (source_hash IS NULL OR source_hash=$3) LIMIT 1",
        [args.scope.ownerUserId, sourceRef, hash],
      )
    : { rows: [] };
  const learningEnabled =
    !excluded.rows.length &&
    (Boolean(args.backfillJobId) || args.scope.learningEnabled);
  // Recorded as already extracted, so neither recall of pending statements nor import revisits it.
  const nothingToLearn = memorySourceHasNoStatement(args.content);
  const result = await db.query<MemorySourceRow>(
    `INSERT INTO memory_sources(id,owner_user_id,scope_id,subject_id,source_kind,source_role,source_ref,
       account_id,message_id,session_id,content_hash,observed_at,epoch,learning_enabled,identity_snapshot,memory_space_id,extracted_revision)
     VALUES($1,$2,$3,$4,'message','user',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,CASE WHEN $15::boolean THEN 1 ELSE 0 END)
     ON CONFLICT(id) DO NOTHING RETURNING *`,
    [
      id,
      args.scope.ownerUserId,
      args.scope.scopeId,
      args.scope.subjectId,
      sourceRef,
      args.accountId,
      args.messageId,
      args.sessionId,
      hash,
      args.observedAt,
      args.scope.epoch,
      learningEnabled,
      JSON.stringify(args.scope),
      memorySpaceId(args.scope),
      nothingToLearn,
    ],
  );
  const source = result.rows[0];
  if (!source?.learning_enabled || nothingToLearn) return source ?? null;
  await queueMemoryJob(db, {
    scope: args.scope,
    kind: 'extract',
    eventType: args.backfillJobId
      ? 'explicit_backfill_grant'
      : 'user_message_committed',
    key: args.backfillJobId
      ? `backfill-grant:${args.backfillJobId}:${source.id}:${source.revision}`
      : `${args.requestId}:user_message_committed:${source.revision}`,
    sourceId: source.id,
    sourceRevision: source.revision,
    requestId: args.requestId,
    ...(args.backfillJobId
      ? { payload: { backfillJobId: args.backfillJobId } }
      : {}),
  });
  await indexMemoryText(db, {
    ownerUserId: source.owner_user_id,
    scopeId: memorySpaceId(args.scope),
    subjectId: source.subject_id,
    kind: 'source',
    id: source.id,
    revision: source.revision,
    text: args.content,
    observedAt: args.observedAt,
  });
  return source;
}

export async function queueMemoryJob(
  db: DbQueryable,
  args: {
    scope: MemoryRequestScope;
    kind: 'extract' | 'backfill';
    eventType: string;
    key: string;
    sourceId?: string;
    sourceRevision?: number;
    requestId?: string;
    payload?: Record<string, unknown>;
  },
): Promise<string> {
  const id = randomUUID();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO memory_jobs(id,owner_user_id,scope_id,subject_id,source_id,source_revision,request_id,
       job_key,kind,event_type,epoch,payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT(job_key) DO UPDATE SET job_key=EXCLUDED.job_key RETURNING id`,
    [
      id,
      args.scope.ownerUserId,
      args.scope.scopeId,
      args.scope.subjectId,
      args.sourceId ?? null,
      args.sourceRevision ?? null,
      args.requestId ?? null,
      args.key,
      args.kind,
      args.eventType,
      args.scope.epoch,
      JSON.stringify(args.payload ?? {}),
    ],
  );
  return rows[0].id;
}

/** `scopeId` is the memory space whose readers may find this text. */
export async function indexMemoryText(
  db: DbQueryable,
  args: {
    ownerUserId: string;
    scopeId: string;
    subjectId: string;
    kind: 'item' | 'source';
    id: string;
    revision: number;
    text: string;
    observedAt?: Date | string;
  },
): Promise<void> {
  await db.query(
    'DELETE FROM memory_index_entries WHERE object_kind=$1 AND object_id=$2 AND object_revision<>$3',
    [args.kind, args.id, args.revision],
  );
  let start = 0;
  while (start < args.text.length) {
    let end = Math.min(start + 400, args.text.length);
    if (end < args.text.length) {
      const split = args.text.lastIndexOf('\n', end);
      if (split > start + 180) end = split + 1;
    }
    await db.query(
      `INSERT INTO memory_index_entries(owner_user_id,scope_id,subject_id,object_kind,object_id,object_revision,
        chunk_start,chunk_end,search_text,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(object_kind,object_id,object_revision,chunk_start)
       DO UPDATE SET search_text=EXCLUDED.search_text,chunk_end=EXCLUDED.chunk_end`,
      [
        args.ownerUserId,
        args.scopeId,
        args.subjectId,
        args.kind,
        args.id,
        args.revision,
        start,
        end,
        args.text.slice(start, end),
        args.observedAt ?? new Date().toISOString(),
      ],
    );
    start = end;
  }
}

/** Explicit backfill reauthorizes processing, never rewrites historical identity or evidence. */
export async function reauthorizeMemorySourceForBackfill(
  db: pg.PoolClient,
  args: {
    scope: MemoryRequestScope;
    sourceId: string;
    backfillJobId: string;
    requestId?: string;
  },
): Promise<boolean> {
  const root = await lockMemoryRoot(args.scope.scopeId, db);
  assertMemoryScopeCurrent(args.scope, root, 'learn');
  await assertMemoryBindingCurrent(args.scope, db);
  const source = await getCurrentMemorySource(args.sourceId, db);
  if (
    !source ||
    source.owner_user_id !== args.scope.ownerUserId ||
    source.scope_id !== args.scope.scopeId ||
    source.epoch !== root.epoch ||
    source.source_role !== 'user'
  )
    return false;
  const oldIdentity = source.identity_snapshot;
  if (oldIdentity && Object.keys(oldIdentity).length) {
    if (
      oldIdentity.scopeId !== source.scope_id ||
      oldIdentity.ownerUserId !== source.owner_user_id ||
      oldIdentity.subjectId !== source.subject_id ||
      oldIdentity.actorKey !== args.scope.actorKey ||
      oldIdentity.audienceKey !== args.scope.audienceKey ||
      (oldIdentity.bindingRevision ?? 1) !== (args.scope.bindingRevision ?? 1)
    )
      return false;
  }
  const afterClear = await db.query<{ allowed: boolean }>(
    'SELECT ($1::timestamptz IS NULL OR $2::timestamptz>$1::timestamptz) AS allowed',
    [root.cleared_at ?? null, source.observed_at],
  );
  if (!afterClear.rows[0]?.allowed) return false;
  await db.query(
    'UPDATE memory_sources SET learning_enabled=true WHERE id=$1',
    [source.id],
  );
  await indexMemoryText(db, {
    ownerUserId: source.owner_user_id,
    scopeId: source.memory_space_id ?? source.scope_id,
    subjectId: source.subject_id,
    kind: 'source',
    id: source.id,
    revision: source.revision,
    text: source.content,
    observedAt: source.observed_at,
  });
  if (
    source.extracted_revision < source.revision &&
    oldIdentity &&
    Object.keys(oldIdentity).length
  )
    await queueMemoryJob(db, {
      scope: { ...oldIdentity, epoch: root.epoch, learningEnabled: true },
      kind: 'extract',
      eventType: 'explicit_backfill_grant',
      key: `backfill-grant:${args.backfillJobId}:${source.id}:${source.revision}`,
      sourceId: source.id,
      sourceRevision: source.revision,
      requestId: args.requestId,
      payload: { backfillJobId: args.backfillJobId },
    });
  return true;
}

export async function revokeMemorySource(
  db: DbQueryable,
  sourceId: string,
): Promise<void> {
  // The memory_source_excluded trigger revokes evidence, unsupported items, index rows and jobs.
  await db.query(
    'UPDATE memory_sources SET excluded_at=clock_timestamp() WHERE id=$1 AND excluded_at IS NULL',
    [sourceId],
  );
}

/** Must run in the bulk transaction; the per-row revocation triggers are suppressed there. */
export async function beginBulkMemoryRemoval(db: DbQueryable): Promise<void> {
  await db.query("SELECT set_config('fateclaw.memory_bulk','on',true)");
}

/**
 * Set-based equivalent of the memory_message_changed and memory_source_* triggers for owners
 * whose messages were removed in bulk.
 */
export async function reconcileRemovedMemorySources(
  db: DbQueryable,
  ownerUserIds: string[],
): Promise<void> {
  const owners = [...new Set(ownerUserIds)];
  if (!owners.length) return;
  const { rows } = await db.query<{ id: string }>(
    `UPDATE memory_sources s SET excluded_at=clock_timestamp()
     WHERE s.owner_user_id=ANY($1::text[]) AND s.excluded_at IS NULL AND s.source_kind='message'
       AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.id=s.message_id AND m.account_id=s.account_id AND m.deleted_at IS NULL)
     RETURNING s.id`,
    [owners],
  );
  const excluded = rows.map((row) => row.id);
  await db.query(
    "UPDATE memory_evidence SET revoked_at=clock_timestamp(),quote='' WHERE source_id=ANY($1::text[]) AND revoked_at IS NULL",
    [excluded],
  );
  // Evidence of hard-deleted sources is already gone by cascade.
  await db.query(
    `UPDATE memory_items i SET status='forgotten',content='[来源已撤销]',updated_at=clock_timestamp()
     WHERE i.owner_user_id=ANY($1::text[]) AND i.status<>'forgotten'
       AND NOT EXISTS(SELECT 1 FROM memory_evidence e WHERE e.item_id=i.id AND e.revoked_at IS NULL)`,
    [owners],
  );
  await db.query(
    `DELETE FROM memory_index_entries x WHERE x.owner_user_id=ANY($1::text[]) AND (
       x.object_kind='source' AND NOT EXISTS(SELECT 1 FROM memory_sources s WHERE s.id=x.object_id AND s.excluded_at IS NULL)
       OR x.object_kind='item' AND EXISTS(SELECT 1 FROM memory_items i WHERE i.id=x.object_id AND i.status='forgotten'))`,
    [owners],
  );
  await db.query(
    `UPDATE memory_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL,error_code='SOURCE_REVOKED',updated_at=clock_timestamp()
     WHERE owner_user_id=ANY($1::text[]) AND kind='extract' AND state IN ('pending','running','paused')
       AND (source_id IS NULL OR source_id=ANY($2::text[]))`,
    [owners, excluded],
  );
}

export async function getCurrentMemorySource(
  sourceId: string,
  db: DbQueryable = getDbPool(),
): Promise<
  | (MemorySourceRow & {
      content: string;
      subject_name: string;
      subject_kind: string;
      actor_key: string;
    })
  | null
> {
  const { rows } = await db.query<
    MemorySourceRow & {
      content: string;
      subject_name: string;
      subject_kind: string;
      actor_key: string;
    }
  >(
    `SELECT s.*,COALESCE(s.manual_content,m.content) AS content,e.name AS subject_name,e.kind AS subject_kind,sc.actor_key,s.observed_at::text AS observed_at
     FROM memory_sources s JOIN memory_entities e ON e.id=s.subject_id JOIN memory_scopes sc ON sc.id=s.scope_id
     LEFT JOIN messages m ON m.id=s.message_id AND m.account_id=s.account_id
     LEFT JOIN client_profiles c ON c.id=e.client_id
     WHERE s.id=$1 AND s.excluded_at IS NULL AND e.deleted_at IS NULL
       AND (e.client_id IS NULL OR c.deleted_at IS NULL)
       AND (s.source_kind<>'message' OR m.id IS NOT NULL AND m.deleted_at IS NULL)`,
    [sourceId],
  );
  const source = rows[0];
  if (
    !source ||
    typeof source.content !== 'string' ||
    memoryHash(source.content) !== source.content_hash
  )
    return null;
  const excluded = await db.query<{
    reason: string;
    quote_start: number | null;
    quote_end: number | null;
  }>(
    `SELECT reason,quote_start,quote_end FROM memory_exclusions WHERE source_id=$1 OR
       (owner_user_id=$2 AND source_ref=$3 AND (source_hash IS NULL OR source_hash=$4))`,
    [source.id, source.owner_user_id, source.source_ref, source.content_hash],
  );
  if (excluded.rows.some((row) => row.reason === 'source_excluded'))
    return null;
  let content = source.content;
  for (const row of excluded.rows) {
    if (row.reason !== 'forgotten_fact') continue;
    const start = row.quote_start;
    const end = row.quote_end;
    if (
      start === null ||
      end === null ||
      start < 0 ||
      end > content.length ||
      end <= start
    )
      return null;
    content =
      content.slice(0, start) + ' '.repeat(end - start) + content.slice(end);
  }
  return { ...source, content };
}

export async function insertMemoryItem(
  db: pg.PoolClient,
  args: {
    scope: MemoryRequestScope;
    subjectId?: string;
    content: string;
    kind?: MemoryKind;
    factKey?: string | null;
    assertionType?: 'stated' | 'experience' | 'plan';
    origin: 'automatic' | 'explicit' | 'manual';
    source?: MemorySourceRow;
    quote?: string;
    validFrom?: string | null;
    validTo?: string | null;
    supersedesId?: string;
  },
): Promise<MemoryItemRow> {
  const root = await lockMemoryRoot(args.scope.scopeId, db);
  if (args.origin !== 'manual')
    await assertMemoryBindingCurrent(args.scope, db);
  if (args.origin === 'manual') {
    if (
      root.owner_user_id !== args.scope.ownerUserId ||
      root.epoch !== args.scope.epoch
    )
      throw new MemoryError(
        '记忆设置已变化，请刷新后重试',
        409,
        'MEMORY.REVOKED',
      );
  } else
    assertMemoryScopeCurrent(
      args.scope,
      root,
      args.origin === 'automatic' ? 'learn' : 'edit',
    );
  const subjectId = args.subjectId ?? args.scope.subjectId;
  const namespace = memorySpaceId(args.scope);
  const namespaceOwner = await db.query(
    'SELECT 1 FROM memory_scopes WHERE id=$1 AND owner_user_id=$2',
    [namespace, args.scope.ownerUserId],
  );
  if (
    !namespaceOwner.rows[0] ||
    (namespace !== args.scope.scopeId &&
      args.origin !== 'manual' &&
      !hasOwnerMemoryAudience(args.scope))
  )
    throw new MemoryError(
      '本次请求未授权写入该记忆空间',
      403,
      'MEMORY.SPACE_DENIED',
    );
  await assertMemorySubject(args.scope, subjectId, db);
  const content = validateMemoryContent(args.content);
  const kind = args.kind ?? 'fact';
  const hash = memoryContentHash(kind, content, args.factKey);
  const excluded = await db.query(
    `SELECT 1 FROM memory_exclusions WHERE scope_id=$1 AND (subject_id IS NULL OR subject_id=$2)
     AND (persistent OR $6::timestamptz <= cutoff_at) AND
       ((source_id=$3 AND reason='source_excluded') OR content_hash=$4 OR fact_key IS NOT NULL AND fact_key=$5) LIMIT 1`,
    [
      namespace,
      subjectId,
      args.source?.id ?? null,
      hash,
      args.factKey ?? null,
      args.source ? isoDate(args.source.observed_at) : new Date().toISOString(),
    ],
  );
  if (args.origin === 'automatic' && excluded.rows[0])
    throw new MemoryError('该来源或记忆已被用户排除', 409, 'MEMORY.EXCLUDED');
  let supersedesId = args.supersedesId;
  if (supersedesId && args.origin === 'automatic') {
    // Automatic extraction never replaces what the user wrote or explicitly asked to save.
    const target = await db.query<{ origin: MemoryItemRow['origin'] }>(
      'SELECT origin FROM memory_items WHERE id=$1 AND owner_user_id=$2',
      [supersedesId, args.scope.ownerUserId],
    );
    if (target.rows[0]?.origin !== 'automatic') supersedesId = undefined;
  }
  const duplicate = await db.query<MemoryItemRow>(
    "SELECT * FROM memory_items WHERE scope_id=$1 AND subject_id=$2 AND content_hash=$3 AND status='active' FOR UPDATE",
    [namespace, subjectId, hash],
  );
  let item = duplicate.rows[0];
  if (item && supersedesId && supersedesId !== item.id) {
    const replaced = await db.query<{ id: string }>(
      "UPDATE memory_items SET status='superseded',merged_into_id=$6,valid_to=COALESCE($5::timestamptz,clock_timestamp()),updated_at=clock_timestamp() WHERE id=$1 AND owner_user_id=$2 AND scope_id=$3 AND subject_id=$4 AND status='active' RETURNING id",
      [
        supersedesId,
        args.scope.ownerUserId,
        namespace,
        subjectId,
        args.validFrom ?? null,
        item.id,
      ],
    );
    if (!replaced.rows[0])
      throw new MemoryError('待修改记忆已发生变化', 409, 'MEMORY.CONFLICT');
    await db.query(
      "DELETE FROM memory_index_entries WHERE object_kind='item' AND object_id=$1",
      [supersedesId],
    );
  }
  if (!item) {
    let previous: MemoryItemRow | undefined;
    if (supersedesId || args.factKey) {
      const found = await db.query<MemoryItemRow>(
        `SELECT existing.*,existing.observed_at::text AS observed_at FROM memory_items existing WHERE scope_id=$1 AND subject_id=$2 AND status='active'
          AND (($3::text IS NOT NULL AND id=$3) OR ($3::text IS NULL AND fact_key=$4))
         ORDER BY existing.source_sequence DESC,existing.observed_at DESC LIMIT 1 FOR UPDATE`,
        [namespace, subjectId, supersedesId ?? null, args.factKey ?? null],
      );
      previous = found.rows[0];
      if (previous && args.origin === 'automatic') {
        const stale = await db.query<{ stale: boolean }>(
          'SELECT ($1::timestamptz>$2::timestamptz OR $1::timestamptz=$2::timestamptz AND $3::bigint>$4::bigint) AS stale',
          [
            previous.observed_at,
            args.source?.observed_at ?? new Date(0).toISOString(),
            previous.source_sequence,
            args.source?.source_sequence ?? 0,
          ],
        );
        if (stale.rows[0].stale)
          throw new MemoryError(
            '已有更新的记忆，不应用迟到的旧陈述',
            409,
            'MEMORY.STALE_SOURCE',
          );
      }
      if (
        previous &&
        args.origin === 'automatic' &&
        previous.origin !== 'automatic'
      )
        previous = undefined;
    }
    const observedAt = args.source
      ? typeof args.source.observed_at === 'string'
        ? args.source.observed_at
        : isoDate(args.source.observed_at)
      : new Date().toISOString();
    if (previous) {
      await db.query(
        "UPDATE memory_items SET status='superseded',valid_to=COALESCE($2::timestamptz,valid_to),updated_at=clock_timestamp() WHERE id=$1",
        [previous.id, args.validFrom ?? observedAt],
      );
      await db.query(
        "DELETE FROM memory_index_entries WHERE object_kind='item' AND object_id=$1",
        [previous.id],
      );
    }
    const { rows } = await db.query<MemoryItemRow>(
      `INSERT INTO memory_items(family_id,owner_user_id,scope_id,subject_id,kind,assertion_type,content,content_hash,
         fact_key,origin,revision,epoch,source_sequence,observed_at,valid_from,valid_to,supersedes_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [
        previous?.family_id ?? randomUUID(),
        args.scope.ownerUserId,
        namespace,
        subjectId,
        kind,
        args.assertionType ?? (kind === 'plan' ? 'plan' : 'stated'),
        content,
        hash,
        args.factKey ?? previous?.fact_key ?? null,
        args.origin,
        previous ? previous.revision + 1 : 1,
        root.epoch,
        args.source?.source_sequence ?? 0,
        observedAt,
        args.validFrom ?? null,
        args.validTo ?? null,
        previous?.id ?? null,
      ],
    );
    item = rows[0];
    await indexMemoryText(db, {
      ownerUserId: item.owner_user_id,
      scopeId: item.scope_id,
      subjectId: item.subject_id,
      kind: 'item',
      id: item.id,
      revision: item.revision,
      text: item.content,
      observedAt: item.observed_at,
    });
  }
  if (args.source && args.quote) {
    const source = await getCurrentMemorySource(args.source.id, db);
    if (
      !source ||
      source.owner_user_id !== args.scope.ownerUserId ||
      (source.memory_space_id ??
        source.identity_snapshot?.memorySpaceId ??
        source.scope_id) !== namespace ||
      source.source_role === 'assistant' ||
      source.revision !== args.source.revision ||
      !source.content.includes(args.quote)
    )
      throw new MemoryError(
        '引用来源已变化，请重新提炼',
        409,
        'MEMORY.SOURCE_CHANGED',
      );
    await db.query(
      `INSERT INTO memory_evidence(item_id,source_id,source_revision,source_hash,quote,quote_start,quote_end)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(item_id,source_id,source_revision,quote_start,quote_end) DO NOTHING`,
      [
        item.id,
        source.id,
        source.revision,
        source.content_hash,
        args.quote,
        source.content.indexOf(args.quote),
        source.content.indexOf(args.quote) + args.quote.length,
      ],
    );
  }
  return item;
}

export async function memoryItemDto(
  item: MemoryItemRow,
  db: DbQueryable = getDbPool(),
): Promise<MemoryItemDto> {
  const { rows } = await db.query<{
    name: string;
    count: string;
    scope_name: string;
  }>(
    `SELECT e.name,(SELECT count(*) FROM memory_evidence v WHERE v.item_id=$1 AND v.revoked_at IS NULL)::text AS count,
       COALESCE((SELECT string_agg(DISTINCT COALESCE(origin.display_name,CASE WHEN origin.parent_scope_id IS NULL THEN '网页对话' ELSE '微信联系人' END),'、')
          FROM memory_evidence proof JOIN memory_sources source ON source.id=proof.source_id JOIN memory_scopes origin ON origin.id=source.scope_id
          WHERE proof.item_id=$1 AND proof.revoked_at IS NULL),sc.display_name,CASE WHEN sc.parent_scope_id IS NULL THEN '网页对话' ELSE '微信联系人' END) AS scope_name
     FROM memory_entities e JOIN memory_scopes sc ON sc.id=$3 WHERE e.id=$2`,
    [item.id, item.subject_id, item.scope_id],
  );
  return {
    id: item.id,
    subject_id: item.subject_id,
    subject_name: rows[0]?.name ?? '未确认对象',
    kind: item.kind,
    scope_id: item.scope_id,
    scope_name: rows[0]?.scope_name,
    content: item.content,
    fact_key: item.fact_key,
    status: item.status,
    origin: item.origin,
    revision: item.revision,
    observed_at: isoDate(item.observed_at),
    valid_from: item.valid_from ? isoDate(item.valid_from) : null,
    valid_to: item.valid_to ? isoDate(item.valid_to) : null,
    created_at: isoDate(item.created_at),
    updated_at: isoDate(item.updated_at),
    evidence_count: Number(rows[0]?.count ?? 0),
  };
}
