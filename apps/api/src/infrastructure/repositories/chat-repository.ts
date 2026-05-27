import { ChatSession, NewMessage } from '../../shared/types.js';
import { getDbPool } from '../db-pool.js';
import { logger } from '../logger.js';
import { getRedis } from '../redis.js';
import { getAccountsByUserId } from './accounts-repository.js';

/** Redis 中每个账号保留的最大历史消息条数。 */
const HISTORY_REDIS_MAX = 500;

export async function storeMessage(msg: NewMessage): Promise<void> {
  await getDbPool().query(
    `INSERT INTO messages (id, account_id, user_id, sender, sender_name, content, timestamp, is_from_me, is_bot_message, tool_context, session_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (id, account_id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       sender = EXCLUDED.sender,
       sender_name = EXCLUDED.sender_name,
       content = EXCLUDED.content,
       timestamp = EXCLUDED.timestamp,
       is_from_me = EXCLUDED.is_from_me,
       is_bot_message = EXCLUDED.is_bot_message,
       tool_context = EXCLUDED.tool_context,
       session_id = EXCLUDED.session_id,
       metadata = EXCLUDED.metadata`,
    [
      msg.id,
      msg.account_id,
      msg.user_id ?? null,
      msg.sender,
      msg.sender_name,
      msg.content,
      msg.timestamp,
      msg.is_from_me ?? false,
      msg.is_bot_message ?? false,
      msg.tool_context ?? null,
      msg.session_id ?? null,
      msg.metadata ? JSON.stringify(msg.metadata) : null,
    ],
  );

  // AI 对话消息不同步到 Redis（Redis 仅用于微信 recall_history 工具）。
  if (msg.session_id) return;

  // Redis 写入失败不影响核心消息流程。
  try {
    const redis = getRedis();
    const key = `history:${msg.account_id}`;
    const entry = JSON.stringify({
      sender: msg.sender,
      sender_name: msg.sender_name,
      content: msg.content,
      timestamp: msg.timestamp,
      is_from_me: msg.is_from_me ?? false,
    });
    await redis.lpush(key, entry);
    await redis.ltrim(key, 0, HISTORY_REDIS_MAX - 1);
  } catch (err) {
    logger.warn({ err, accountId: msg.account_id }, '消息同步到 Redis 失败');
  }
}

export async function getRecentMessages(
  accountId: string,
  limit: number = 50,
  before?: string,
  after?: string,
  sessionId?: string,
): Promise<NewMessage[]> {
  const conditions = ['account_id = $1', 'deleted_at IS NULL'];
  const params: unknown[] = [accountId, limit];

  if (sessionId) {
    params.push(sessionId);
    conditions.push(`session_id = $${params.length}`);
  } else {
    conditions.push('session_id IS NULL');
  }

  if (before) {
    params.push(before);
    conditions.push(`timestamp < $${params.length}`);
  }
  if (after) {
    params.push(after);
    conditions.push(`timestamp > $${params.length}`);
  }

  const { rows } = await getDbPool().query(
    `SELECT * FROM messages
     WHERE ${conditions.join(' AND ')}
     ORDER BY timestamp DESC LIMIT $2`,
    params,
  );
  return rows as NewMessage[];
}

export async function getSessionMessageById(
  accountId: string,
  sessionId: string,
  messageId: string,
): Promise<NewMessage | undefined> {
  const { rows } = await getDbPool().query(
    `SELECT * FROM messages
     WHERE account_id = $1
       AND session_id = $2
       AND id = $3
       AND deleted_at IS NULL
     LIMIT 1`,
    [accountId, sessionId, messageId],
  );
  return rows[0] as NewMessage | undefined;
}

export async function getMessagesSince(
  accountId: string,
  sinceTimestamp: string,
  limit: number = 200,
): Promise<NewMessage[]> {
  const { rows } = await getDbPool().query(
    `SELECT * FROM messages
     WHERE account_id = $1 AND timestamp > $2 AND is_bot_message = false AND deleted_at IS NULL
     ORDER BY timestamp DESC LIMIT $3`,
    [accountId, sinceTimestamp, limit],
  );
  return rows as NewMessage[];
}

export async function createChatSession(session: {
  id: string;
  accountId: string;
  userId: string;
  title: string;
}): Promise<ChatSession> {
  const { rows } = await getDbPool().query(
    `INSERT INTO chat_sessions (id, account_id, user_id, title)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [session.id, session.accountId, session.userId, session.title],
  );
  return rows[0] as ChatSession;
}

export async function getChatSessions(
  accountId: string,
  limit = 100,
): Promise<ChatSession[]> {
  const { rows } = await getDbPool().query(
    `SELECT * FROM chat_sessions
     WHERE account_id = $1 AND deleted_at IS NULL
     ORDER BY updated_at DESC
     LIMIT $2`,
    [accountId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows as ChatSession[];
}

export async function getChatSessionsByUserId(
  userId: string,
  limit = 100,
): Promise<ChatSession[]> {
  const { rows } = await getDbPool().query(
    `SELECT * FROM chat_sessions
     WHERE user_id = $1 AND deleted_at IS NULL
     ORDER BY updated_at DESC
     LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows as ChatSession[];
}

export async function getChatSession(
  id: string,
): Promise<ChatSession | undefined> {
  const { rows } = await getDbPool().query(
    'SELECT * FROM chat_sessions WHERE id = $1 AND deleted_at IS NULL',
    [id],
  );
  return rows[0] as ChatSession | undefined;
}

export async function updateChatSessionTitle(
  id: string,
  title: string,
): Promise<void> {
  await getDbPool().query(
    `UPDATE chat_sessions SET title = $2, updated_at = NOW() WHERE id = $1`,
    [id, title],
  );
}

export async function touchChatSession(id: string): Promise<void> {
  await getDbPool().query(
    `UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1`,
    [id],
  );
}

export async function deleteChatSession(id: string): Promise<void> {
  await getDbPool().query(
    `UPDATE chat_sessions SET deleted_at = NOW() WHERE id = $1`,
    [id],
  );
  await getDbPool().query(
    `UPDATE messages SET deleted_at = NOW() WHERE session_id = $1 AND deleted_at IS NULL`,
    [id],
  );
}

export async function resetUserMessages(userId: string): Promise<string[]> {
  const now = new Date().toISOString();
  const userAccounts = await getAccountsByUserId(userId);
  const accountIds = userAccounts.map((a) => a.id);

  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    for (const accountId of accountIds) {
      await client.query(
        'UPDATE messages SET deleted_at = $1 WHERE account_id = $2 AND deleted_at IS NULL',
        [now, accountId],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return accountIds;
}
