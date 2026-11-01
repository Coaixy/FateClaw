import type {
  MemoryScopeDto,
  MemorySubjectDto,
} from '@fateclaw/contracts/memory';
import { z } from 'zod';
import { getDbPool, type DbQueryable } from '#infrastructure/db-pool';
import { MemoryError, type MemoryScopeRow } from './domain.js';
import {
  ensureOwnerMemoryScope,
  lockMemoryRoot,
  withMemoryTransaction,
} from './repository.js';

export const memoryScopeBindingSchema = z.strictObject({
  speaker_subject_id: z.string().trim().min(1).max(256).nullable(),
  share_subject_memory: z.boolean(),
  display_name: z.string().trim().min(1).max(120).optional(),
  revision: z.number().int().positive().max(2_147_483_646),
});

interface ScopeMetadataRow {
  id: string;
  channel: 'web' | 'wechat';
  display_name: string | null;
  bound_subject_id: string | null;
  share_subject_memory: boolean;
  binding_revision: number;
  display_ordinal: string;
}

type BindingRow = MemoryScopeRow & {
  bound_subject_id: string | null;
  share_subject_memory: boolean;
  binding_revision: number;
  display_name: string | null;
};

async function readScopes(
  ownerUserId: string,
  rootId: string,
  db: DbQueryable,
): Promise<MemoryScopeDto[]> {
  const { rows } = await db.query<ScopeMetadataRow>(
    `SELECT id,CASE WHEN id=$2 THEN 'web' ELSE 'wechat' END AS channel,
       display_name,bound_subject_id,share_subject_memory,binding_revision,
       row_number() OVER(PARTITION BY id=$2 ORDER BY created_at,id)::text AS display_ordinal
     FROM memory_scopes WHERE owner_user_id=$1 AND (id=$2 OR parent_scope_id=$2 AND actor_key LIKE 'wechat:%')
     ORDER BY (id=$2) DESC,created_at,id`,
    [ownerUserId, rootId],
  );
  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    display_name:
      row.display_name?.trim() ||
      (row.channel === 'web'
        ? '网页对话'
        : `微信联系人 ${row.display_ordinal}`),
    speaker_subject_id:
      row.channel === 'web' ? `self:${ownerUserId}` : row.bound_subject_id,
    share_subject_memory:
      row.channel === 'web' ? false : row.share_subject_memory,
    binding_revision: row.binding_revision,
  }));
}

export async function listMemoryScopes(
  ownerUserId: string,
): Promise<{ scopes: MemoryScopeDto[]; subjects: MemorySubjectDto[] }> {
  const db = getDbPool();
  const root = await ensureOwnerMemoryScope(ownerUserId, db);
  const [scopes, subjects] = await Promise.all([
    readScopes(ownerUserId, root.id, db),
    db.query<MemorySubjectDto>(
      `SELECT id,kind,name FROM memory_entities WHERE owner_user_id=$1 AND id=$2 AND kind='self' AND deleted_at IS NULL
       UNION ALL
       SELECT 'client:'||c.id AS id,'client' AS kind,c.name FROM client_profiles c
       LEFT JOIN memory_entities e ON e.id='client:'||c.id
       WHERE c.user_id=$1 AND c.deleted_at IS NULL AND
         (e.id IS NULL OR e.owner_user_id=$1 AND e.kind='client' AND e.client_id=c.id AND e.deleted_at IS NULL)
       ORDER BY kind,name,id`,
      [ownerUserId, `self:${ownerUserId}`],
    ),
  ]);
  return { scopes, subjects: subjects.rows };
}

async function requireBindingSubject(
  ownerUserId: string,
  rootId: string,
  subjectId: string,
  db: DbQueryable,
): Promise<void> {
  if (subjectId === `self:${ownerUserId}`) {
    const subject = await db.query(
      "SELECT id FROM memory_entities WHERE id=$1 AND owner_user_id=$2 AND kind='self' AND deleted_at IS NULL",
      [subjectId, ownerUserId],
    );
    if (subject.rows[0]) return;
  } else if (subjectId.startsWith('client:')) {
    const client = await db.query<{ id: string; name: string }>(
      'SELECT id,name FROM client_profiles WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR SHARE',
      [subjectId.slice('client:'.length), ownerUserId],
    );
    if (client.rows[0]) {
      const entity = await db.query(
        `INSERT INTO memory_entities(id,owner_user_id,scope_id,kind,client_id,name)
         VALUES($1,$2,$3,'client',$4,$5) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name
         WHERE memory_entities.owner_user_id=EXCLUDED.owner_user_id AND memory_entities.kind='client'
           AND memory_entities.client_id=EXCLUDED.client_id AND memory_entities.deleted_at IS NULL RETURNING id`,
        [
          subjectId,
          ownerUserId,
          rootId,
          client.rows[0].id,
          client.rows[0].name,
        ],
      );
      if (entity.rows[0]) return;
    }
  }
  throw new MemoryError(
    '只能绑定当前账号本人或仍在档的命主',
    403,
    'MEMORY.SUBJECT_INACTIVE',
  );
}

export async function updateMemoryScopeBinding(
  ownerUserId: string,
  scopeId: string,
  input: unknown,
): Promise<MemoryScopeDto> {
  const binding = memoryScopeBindingSchema.parse(input);
  if (binding.share_subject_memory && binding.speaker_subject_id === null)
    throw new MemoryError(
      '请先明确绑定说话人，再授权使用该主体的既有记忆',
      400,
      'MEMORY.BINDING_REQUIRED',
    );
  return withMemoryTransaction(async (db) => {
    const owner = await ensureOwnerMemoryScope(ownerUserId, db);
    const root = await lockMemoryRoot(owner.id, db);
    const { rows } = await db.query<BindingRow>(
      'SELECT * FROM memory_scopes WHERE id=$1 AND owner_user_id=$2 AND (id=$3 OR parent_scope_id=$3) FOR UPDATE',
      [scopeId, ownerUserId, root.id],
    );
    const scope = rows[0];
    if (!scope)
      throw new MemoryError(
        '记忆说话人不存在或无权访问',
        404,
        'MEMORY.SCOPE_MISSING',
      );
    if (scope.binding_revision !== binding.revision)
      throw new MemoryError(
        '说话人绑定已被更新，请刷新后重试',
        409,
        'MEMORY.BINDING_CONFLICT',
      );
    const web = scope.id === root.id;
    if (
      web &&
      (binding.speaker_subject_id !== `self:${ownerUserId}` ||
        binding.share_subject_memory)
    )
      throw new MemoryError(
        '网页对话固定属于当前账号本人，不能改绑或向外共享',
        400,
        'MEMORY.WEB_BINDING_FIXED',
      );
    if (!web && !scope.actor_key.startsWith('wechat:'))
      throw new MemoryError(
        '该说话人渠道不支持绑定',
        400,
        'MEMORY.SCOPE_INVALID',
      );
    if (binding.speaker_subject_id)
      await requireBindingSubject(
        ownerUserId,
        root.id,
        binding.speaker_subject_id,
        db,
      );
    const subjectId = web ? null : binding.speaker_subject_id;
    const displayName = binding.display_name ?? scope.display_name;
    const identityChanged =
      scope.bound_subject_id !== subjectId ||
      scope.share_subject_memory !== binding.share_subject_memory;
    const changed = identityChanged || scope.display_name !== displayName;
    if (changed) {
      // Only identity changes advance the revision that in-flight requests and jobs are fenced on.
      const updated = await db.query(
        `UPDATE memory_scopes SET bound_subject_id=$3,share_subject_memory=$4,display_name=$5,
           binding_revision=binding_revision+CASE WHEN $7::boolean THEN 1 ELSE 0 END,updated_at=clock_timestamp()
         WHERE id=$1 AND owner_user_id=$2 AND binding_revision=$6 RETURNING id`,
        [
          scopeId,
          ownerUserId,
          subjectId,
          binding.share_subject_memory,
          displayName,
          binding.revision,
          identityChanged,
        ],
      );
      if (!updated.rows[0])
        throw new MemoryError(
          '说话人绑定已被更新，请刷新后重试',
          409,
          'MEMORY.BINDING_CONFLICT',
        );
      // Cosmetic edits retain active work; identity changes revoke the previous audience.
      if (identityChanged) {
        await db.query(
          `UPDATE memory_jobs j SET state='cancelled',lease_token=NULL,lease_until=NULL,
           error_code='BINDING_CHANGED',updated_at=clock_timestamp()
         WHERE j.owner_user_id=$1 AND j.scope_id=$2 AND j.state IN ('pending','running','paused')
           AND j.kind='extract'`,
          [ownerUserId, scopeId],
        );
        await db.query(
          `UPDATE pi_session_contexts c SET context_generation=context_generation+1,initialized=false,updated_at=clock_timestamp()
           WHERE c.context_audience=$2 AND EXISTS(SELECT 1 FROM chat_sessions s WHERE s.id=c.session_id AND s.user_id=$1)`,
          [ownerUserId, scope.audience_key],
        );
        await db.query(
          "UPDATE agent_requests SET cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()) WHERE owner_user_id=$1 AND memory_scope->>'scopeId'=$2 AND state IN ('queued','dispatched','running')",
          [ownerUserId, scopeId],
        );
      }
    }
    const saved = (await readScopes(ownerUserId, root.id, db)).find(
      (row) => row.id === scopeId,
    );
    if (!saved)
      throw new MemoryError(
        '记忆说话人不存在或无权访问',
        404,
        'MEMORY.SCOPE_MISSING',
      );
    return saved;
  });
}
