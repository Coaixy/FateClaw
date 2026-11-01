import { z } from 'zod';
import type { MemorySessionSettingsDto } from '@fateclaw/contracts/memory';
import { getDbPool } from '#infrastructure/db-pool';
import { MemoryError } from './domain.js';
import {
  ensureOwnerMemoryScope,
  lockMemoryRoot,
  withMemoryTransaction,
} from './repository.js';

export const memorySessionSettingsSchema = z.strictObject({
  learning_enabled: z.boolean(),
  revision: z.number().int().positive().max(2_147_483_646),
});

interface SessionRow {
  id: string;
  title: string;
  memory_learning_enabled: boolean;
  memory_learning_revision: number;
  sort_at: string;
}

const cursorSchema = z.strictObject({
  at: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => Number.isFinite(Date.parse(value))),
  id: z.string().min(1).max(256),
});

function readCursor(cursor?: string): z.infer<typeof cursorSchema> | null {
  if (!cursor) return null;
  try {
    return cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
  } catch {
    throw new MemoryError('会话分页参数无效。', 400, 'MEMORY.INVALID_CURSOR');
  }
}

function dto(row: SessionRow): MemorySessionSettingsDto {
  return {
    id: row.id,
    title: row.title.trim() || '未命名会话',
    learning_enabled: row.memory_learning_enabled,
    revision: row.memory_learning_revision,
  };
}

export async function listMemorySessions(
  ownerUserId: string,
  args: { cursor?: string; limit?: number } = {},
): Promise<{
  sessions: MemorySessionSettingsDto[];
  next_cursor: string | null;
}> {
  const limit = args.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new MemoryError('每页会话数量必须为 1 到 200。');
  const cursor = readCursor(args.cursor);
  const { rows } = await getDbPool().query<SessionRow>(
    `SELECT id,title,memory_learning_enabled,memory_learning_revision,updated_at::text AS sort_at
     FROM chat_sessions WHERE user_id=$1 AND deleted_at IS NULL AND id NOT LIKE 'openapi:%'
       AND ($2::timestamptz IS NULL OR (updated_at,id)<($2::timestamptz,$3::text))
     ORDER BY updated_at DESC,id DESC LIMIT $4`,
    [ownerUserId, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
  );
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  return {
    sessions: selected.map(dto),
    next_cursor:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({ at: last.sort_at, id: last.id }),
          ).toString('base64url')
        : null,
  };
}

export async function updateMemorySessionSettings(
  ownerUserId: string,
  sessionId: string,
  input: unknown,
): Promise<MemorySessionSettingsDto> {
  const settings = memorySessionSettingsSchema.parse(input);
  return withMemoryTransaction(async (db) => {
    const root = await ensureOwnerMemoryScope(ownerUserId, db);
    await lockMemoryRoot(root.id, db);
    const { rows } = await db.query<SessionRow>(
      `SELECT id,title,memory_learning_enabled,memory_learning_revision FROM chat_sessions
       WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL AND id NOT LIKE 'openapi:%' FOR UPDATE`,
      [sessionId, ownerUserId],
    );
    const current = rows[0];
    if (!current)
      throw new MemoryError(
        '会话不存在或无权访问。',
        404,
        'MEMORY.SESSION_MISSING',
      );
    if (current.memory_learning_revision !== settings.revision)
      throw new MemoryError(
        '会话学习设置已变化，请刷新后重试。',
        409,
        'MEMORY.SESSION_CONFLICT',
      );
    if (current.memory_learning_enabled === settings.learning_enabled)
      return dto(current);
    const changed = await db.query<SessionRow>(
      `UPDATE chat_sessions SET memory_learning_enabled=$3,memory_learning_revision=memory_learning_revision+1
       WHERE id=$1 AND user_id=$2 AND memory_learning_revision=$4 RETURNING id,title,memory_learning_enabled,memory_learning_revision`,
      [sessionId, ownerUserId, settings.learning_enabled, settings.revision],
    );
    if (!changed.rows[0])
      throw new MemoryError(
        '会话学习设置已变化，请刷新后重试。',
        409,
        'MEMORY.SESSION_CONFLICT',
      );
    // Apply re-reads this switch; explicit history imports keep their own user authorization.
    if (!settings.learning_enabled)
      await db.query(
        `UPDATE memory_jobs j SET state='cancelled',lease_token=NULL,lease_until=NULL,
       error_code='MEMORY.SESSION_LEARNING_CHANGED',updated_at=clock_timestamp()
       WHERE j.owner_user_id=$1 AND j.kind='extract' AND j.state IN ('pending','running','paused')
         AND j.event_type<>'explicit_backfill_grant' AND NOT(j.payload ? 'backfillJobId')
         AND (EXISTS(SELECT 1 FROM memory_sources s WHERE s.id=j.source_id AND s.owner_user_id=$1 AND s.session_id=$2)
           OR EXISTS(SELECT 1 FROM agent_requests r WHERE r.request_id=j.request_id AND r.owner_user_id=$1 AND r.session_id=$2))`,
        [ownerUserId, sessionId],
      );
    return dto(changed.rows[0]);
  });
}
