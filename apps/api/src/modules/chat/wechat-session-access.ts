import type { ChatSessionDto } from '@fateclaw/contracts/chat';
import type { PoolClient } from 'pg';
import { MemoryError, memoryHash } from '#modules/memory/domain';
import {
  ensureOwnerMemoryScope,
  withMemoryTransaction,
} from '#modules/memory/repository';
import { getWebChatRuntimeId } from './web-chat-runtime.js';

export interface WechatSessionIdentity {
  userId: string;
  accountId: string;
  senderHash: string;
}

interface WechatSessionAccess extends WechatSessionIdentity {
  actorKey: string;
  canReadOwnerSessions: boolean;
}

interface SessionRow {
  id: string;
  account_id: string;
  title: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

async function withWechatSessionAccess<T>(
  identity: WechatSessionIdentity,
  run: (access: WechatSessionAccess, db: PoolClient) => Promise<T>,
): Promise<T> {
  return withMemoryTransaction(async (db) => {
    const root = await ensureOwnerMemoryScope(identity.userId, db);
    const account = await db.query(
      'SELECT id FROM accounts WHERE id=$1 AND owner_id=$2',
      [identity.accountId, identity.userId],
    );
    if (!account.rows[0])
      throw new MemoryError(
        '微信账号不存在或无权访问',
        403,
        'MEMORY.ACTOR_DENIED',
      );
    const actorKey = `wechat:${identity.accountId}:${identity.senderHash}`;
    const audienceKey = `sender:${memoryHash(actorKey)}`;
    await db.query(
      `INSERT INTO memory_scopes(owner_user_id,parent_scope_id,actor_key,audience_key)
       VALUES($1,$2,$3,$4) ON CONFLICT(owner_user_id,actor_key,audience_key) DO NOTHING`,
      [identity.userId, root.id, actorKey, audienceKey],
    );
    const { rows } = await db.query<{
      id: string;
      bound_subject_id: string | null;
      share_subject_memory: boolean;
      owner_subject_active: boolean;
    }>(
      `SELECT id,bound_subject_id,share_subject_memory,EXISTS(SELECT 1 FROM memory_entities
         WHERE id='self:'||$1 AND owner_user_id=$1 AND kind='self' AND deleted_at IS NULL) AS owner_subject_active
       FROM memory_scopes WHERE owner_user_id=$1 AND parent_scope_id=$2 AND actor_key=$3 AND audience_key=$4`,
      [identity.userId, root.id, actorKey, audienceKey],
    );
    const scope = rows[0];
    if (!scope)
      throw new MemoryError('微信说话人身份不可用', 403, 'MEMORY.ACTOR_DENIED');
    await db.query(
      "INSERT INTO memory_entities(id,owner_user_id,scope_id,kind,name) VALUES($1,$2,$3,'sender','微信联系人') ON CONFLICT(id) DO NOTHING",
      [`sender:${memoryHash(actorKey)}`, identity.userId, scope.id],
    );
    // QR metadata identifies the account; only an explicit current binding grants owner history.
    const canReadOwnerSessions =
      scope.bound_subject_id === `self:${identity.userId}` &&
      scope.share_subject_memory &&
      scope.owner_subject_active;
    return run({ ...identity, actorKey, canReadOwnerSessions }, db);
  });
}

export async function ensureWechatSessionActor(
  identity: WechatSessionIdentity,
): Promise<{ actorKey: string }> {
  return withWechatSessionAccess(identity, async ({ actorKey }) => ({
    actorKey,
  }));
}

async function readAccessibleSessions(
  access: WechatSessionAccess,
  db: PoolClient,
  sessionId: string | null,
  limit: number,
): Promise<ChatSessionDto[]> {
  const { rows } = await db.query<SessionRow>(
    `SELECT s.id,s.account_id,
       CASE WHEN $6 THEN s.title WHEN s.created_actor_key=$5 THEN s.created_actor_title ELSE own.first_content END AS title,
       s.created_at,s.updated_at FROM chat_sessions s
     LEFT JOIN LATERAL (
       SELECT m.id,left(m.content,160) AS first_content FROM messages m
       WHERE m.session_id=s.id AND m.account_id=s.account_id AND m.user_id=s.user_id
         AND m.deleted_at IS NULL AND m.is_from_me IS FALSE AND m.is_bot_message IS NOT TRUE
         AND m.metadata->>'source_channel'='wechat' AND m.metadata->>'wechat_account_id'=$3
         AND m.metadata->>'sender_hash'=$4 ORDER BY m.timestamp,m.id LIMIT 1
     ) own ON true
     WHERE s.user_id=$1 AND s.account_id=$2 AND s.deleted_at IS NULL AND s.id NOT LIKE 'openapi:%'
       AND ($7::text IS NULL OR s.id=$7) AND ($6 OR s.created_actor_key=$5 OR own.id IS NOT NULL
         OR EXISTS(SELECT 1 FROM wechat_chat_session_links l WHERE l.account_id=$3 AND l.sender_hash=$4
           AND l.user_id=$1 AND l.session_id=s.id))
     ORDER BY s.updated_at DESC,s.id LIMIT $8`,
    [
      access.userId,
      getWebChatRuntimeId(access.userId),
      access.accountId,
      access.senderHash,
      access.actorKey,
      access.canReadOwnerSessions,
      sessionId,
      limit,
    ],
  );
  return rows.map((row) => {
    const title = row.title?.replace(/\s+/g, ' ').trim() || '微信对话';
    return {
      id: row.id,
      account_id: row.account_id,
      title: access.canReadOwnerSessions
        ? title
        : Array.from(title).slice(0, 48).join(''),
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      share_token: null,
    };
  });
}

export async function listWechatAccessibleSessions(
  identity: WechatSessionIdentity,
  limit = 5,
): Promise<ChatSessionDto[]> {
  return withWechatSessionAccess(identity, (access, db) =>
    readAccessibleSessions(access, db, null, Math.min(Math.max(limit, 1), 100)),
  );
}

export async function getWechatAccessibleSession(
  identity: WechatSessionIdentity,
  sessionId: string,
): Promise<ChatSessionDto | null> {
  return withWechatSessionAccess(
    identity,
    async (access, db) =>
      (await readAccessibleSessions(access, db, sessionId, 1))[0] ?? null,
  );
}
