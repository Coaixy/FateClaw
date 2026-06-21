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

export async function getSessionMessages(
  accountId: string,
  sessionId: string,
): Promise<NewMessage[]> {
  const { rows } = await getDbPool().query(
    `SELECT * FROM messages
     WHERE account_id = $1
       AND session_id = $2
       AND deleted_at IS NULL
     ORDER BY timestamp ASC`,
    [accountId, sessionId],
  );
  return rows as NewMessage[];
}

/**
 * 管理员按 sessionId 读取一条会话的全部消息（不带 account 归属过滤）。
 *
 * @param sessionId chat_sessions.id。
 * @returns 该会话全部未删除消息，按时间升序（含 tool_context / metadata，与用户侧一致）。
 * @remarks 仅供后台 admin 查看会话详情用；一条会话消息量可能很大，调用方需注意性能。
 */
export async function getSessionMessagesForAdmin(
  sessionId: string,
): Promise<NewMessage[]> {
  const { rows } = await getDbPool().query(
    `SELECT * FROM messages
     WHERE session_id = $1
       AND deleted_at IS NULL
     ORDER BY timestamp ASC`,
    [sessionId],
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

/**
 * 更新己方会话内某条消息的正文(工作流"润色"用:卦师改 AI 产出后供后续步骤读取)。
 *
 * @param accountId 运行时账号键(owner 隔离)。
 * @param sessionId chat_sessions.id。
 * @param messageId 目标消息 id。
 * @param content 新正文。
 * @returns 命中并更新返回 true,否则 false。
 */
export async function updateOwnedMessageContent(
  accountId: string,
  sessionId: string,
  messageId: string,
  content: string,
): Promise<boolean> {
  const { rowCount } = await getDbPool().query(
    `UPDATE messages
     SET content = $4
     WHERE account_id = $1 AND session_id = $2 AND id = $3 AND deleted_at IS NULL`,
    [accountId, sessionId, messageId, content],
  );
  return (rowCount ?? 0) > 0;
}

export async function getSessionMessagesWithToolContext(
  accountId: string,
  sessionId: string,
): Promise<NewMessage[]> {
  const { rows } = await getDbPool().query(
    `SELECT * FROM messages
     WHERE account_id = $1
       AND session_id = $2
       AND tool_context IS NOT NULL
       AND deleted_at IS NULL
     ORDER BY timestamp DESC`,
    [accountId, sessionId],
  );
  return rows as NewMessage[];
}

/**
 * 判断站内 AI Chat 会话是否已经产生过真实 AI 回复。
 *
 * @param accountId - 站内运行时账号键，通常为 web:{userId}。
 * @param sessionId - chat_sessions.id。
 * @returns 有最终助手回复时返回 true；仅有排盘预览消息时返回 false。
 */
export async function hasFinalAiChatSessionReply(
  accountId: string,
  sessionId: string,
): Promise<boolean> {
  const { rows } = await getDbPool().query(
    `SELECT 1
     FROM messages
     WHERE account_id = $1
       AND session_id = $2
       AND is_bot_message = true
       AND deleted_at IS NULL
       AND (
         metadata->>'kind' = 'final'
         OR id LIKE 'aichat-%_reply%'
       )
     LIMIT 1`,
    [accountId, sessionId],
  );
  return rows.length > 0;
}

export async function createChatSession(session: {
  id: string;
  accountId: string;
  userId: string;
  title: string;
  /** 关联的客户档案 id；不传则会话不绑定客户。 */
  clientId?: string;
  /** 会话来源:'chat'(默认,直接对话) / 'workflow_run'(工作流运行,不进对话历史)。 */
  origin?: string;
  /** workflow 运行会话关联的工作流定义 id。 */
  workflowDefinitionId?: string;
}): Promise<ChatSession> {
  const { rows } = await getDbPool().query(
    `INSERT INTO chat_sessions
       (id, account_id, user_id, title, client_id, origin, workflow_definition_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      session.id,
      session.accountId,
      session.userId,
      session.title,
      session.clientId ?? null,
      session.origin ?? 'chat',
      session.workflowDefinitionId ?? null,
    ],
  );
  return rows[0] as ChatSession;
}

/**
 * 列出某工作流的全部运行会话(origin='workflow_run'),供 workflow 运行历史展示。
 *
 * @param userId 卦师用户 ID(owner 隔离)。
 * @param workflowDefinitionId 工作流定义 ID。
 * @param limit 返回上限。
 * @returns 按创建时间倒序的运行会话列表。
 */
export async function listWorkflowRunSessions(
  userId: string,
  workflowDefinitionId: string,
  limit = 50,
): Promise<ChatSession[]> {
  const { rows } = await getDbPool().query(
    `SELECT * FROM chat_sessions
     WHERE user_id = $1
       AND workflow_definition_id = $2
       AND origin = 'workflow_run'
       AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT $3`,
    [userId, workflowDefinitionId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows as ChatSession[];
}

export async function getChatSessionsByUserId(
  userId: string,
  limit = 100,
  clientId?: string,
): Promise<ChatSession[]> {
  // origin = 'chat':workflow 运行会话(origin='workflow_run')不进对话历史侧栏。
  const conditions = ['user_id = $1', 'deleted_at IS NULL', "origin = 'chat'"];
  const params: unknown[] = [userId, Math.min(Math.max(limit, 1), 500)];

  // 传入 clientId 时只返回该客户名下的会话（客户档案详情页用）。
  if (clientId) {
    params.push(clientId);
    conditions.push(`client_id = $${params.length}`);
  }

  const { rows } = await getDbPool().query(
    `SELECT * FROM chat_sessions
     WHERE ${conditions.join(' AND ')}
     ORDER BY updated_at DESC
     LIMIT $2`,
    params,
  );
  return rows as ChatSession[];
}

/**
 * 读取当前用户已归档的 AI Chat 会话。
 *
 * @param userId 会话归属用户 ID。
 * @param limit 返回数量上限。
 * @returns 按归档时间倒序排列的会话列表。
 */
export async function getArchivedChatSessionsByUserId(
  userId: string,
  limit = 100,
): Promise<ChatSession[]> {
  const { rows } = await getDbPool().query(
    `SELECT * FROM chat_sessions
     WHERE user_id = $1 AND deleted_at IS NOT NULL AND origin = 'chat'
     ORDER BY deleted_at DESC, updated_at DESC
     LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows as ChatSession[];
}

/**
 * 读取某客户名下的全部会话（含活跃与已归档），用于客户档案历史视图。
 *
 * @param userId 会话归属用户 ID（owner 隔离）。
 * @param clientId 客户档案 ID。
 * @param limit 返回数量上限。
 * @returns 按更新时间倒序的会话列表；已归档会话的 deleted_at 非空。
 */
export async function getChatSessionsByClientId(
  userId: string,
  clientId: string,
  limit = 200,
): Promise<ChatSession[]> {
  const { rows } = await getDbPool().query(
    `SELECT * FROM chat_sessions
     WHERE user_id = $1 AND client_id = $2 AND origin = 'chat'
     ORDER BY updated_at DESC
     LIMIT $3`,
    [userId, clientId, Math.min(Math.max(limit, 1), 500)],
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

/**
 * 管理员按 id 读取任意会话（不过滤 deleted_at，可见已归档）。
 *
 * @param id chat_sessions.id。
 * @returns 会话行；不存在时返回 undefined。
 * @remarks 仅供后台 admin 查看会话详情用，无 user 归属过滤、不过滤归档态。
 */
export async function getChatSessionByIdForAdmin(
  id: string,
): Promise<ChatSession | undefined> {
  const { rows } = await getDbPool().query(
    'SELECT * FROM chat_sessions WHERE id = $1',
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

/**
 * 归档单个 AI Chat 会话。
 *
 * @param id chat_sessions.id。
 * @returns 无返回值。
 *
 * 注意：这里保留 deleted_at 作为数据库字段名，是为了复用现有软删除 schema；
 * 产品语义上它代表用户主动归档。
 */
export async function archiveChatSession(id: string): Promise<void> {
  await getDbPool().query(
    `UPDATE chat_sessions
     SET deleted_at = NOW(), share_token = NULL
     WHERE id = $1`,
    [id],
  );
}

/**
 * 恢复当前用户拥有的已归档 AI Chat 会话。
 *
 * @param input.userId 会话归属用户 ID。
 * @param input.sessionId chat_sessions.id。
 * @returns 恢复后的会话；会话不存在、无权限或未归档时返回 undefined。
 */
export async function restoreArchivedChatSession(input: {
  userId: string;
  sessionId: string;
}): Promise<ChatSession | undefined> {
  const { rows } = await getDbPool().query(
    `UPDATE chat_sessions
     SET deleted_at = NULL, updated_at = NOW()
     WHERE id = $1
       AND user_id = $2
       AND deleted_at IS NOT NULL
     RETURNING *`,
    [input.sessionId, input.userId],
  );
  return rows[0] as ChatSession | undefined;
}

/** Pi session 归档状态，payload 保存可回写本地 jsonl/path 的原始内容。 */
export interface ChatSessionPiSessionArchiveRow {
  id: string;
  pi_session_archived_at: string | null;
  pi_session_archive_reason: string | null;
  pi_session_archive_payload: unknown;
  pi_session_archive_restored_at: string | null;
}

/**
 * 标记会话的 Pi session 已归档到数据库。
 *
 * @param input.sessionId - chat_sessions.id。
 * @param input.reason - 归档原因，用于后台区分软删除和超期清理。
 * @param input.payload - 可回写本地 jsonl/path 的归档 JSON。
 * @returns 是否实际更新到一行会话。
 */
export async function markChatSessionPiSessionArchived(input: {
  sessionId: string;
  reason: 'soft_deleted' | 'inactive';
  payload: unknown;
}): Promise<boolean> {
  const { rowCount } = await getDbPool().query(
    `UPDATE chat_sessions
     SET pi_session_archived_at = NOW(),
         pi_session_archive_reason = $2,
         pi_session_archive_payload = $3::jsonb,
         pi_session_archive_restored_at = NULL
     WHERE id = $1`,
    [input.sessionId, input.reason, JSON.stringify(input.payload)],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * 读取会话的 Pi session 数据库归档。
 *
 * @param sessionId - chat_sessions.id。
 * @returns 包含可回写 payload 的归档行；不存在或无 payload 时返回 undefined。
 *
 * 注意：历史数据或人工修复可能只补了 pi_session_archive_payload，
 * 没有同步 pi_session_archived_at。恢复判断只依赖 payload 是否可回写，
 * 因此这里不能用 archived_at 作为硬条件。
 */
export async function getChatSessionPiSessionArchive(
  sessionId: string,
): Promise<ChatSessionPiSessionArchiveRow | undefined> {
  const { rows } = await getDbPool().query(
    `SELECT id,
            pi_session_archived_at,
            pi_session_archive_reason,
            pi_session_archive_payload,
            pi_session_archive_restored_at
	     FROM chat_sessions
	     WHERE id = $1
	       AND pi_session_archive_payload IS NOT NULL`,
    [sessionId],
  );
  return rows[0] as ChatSessionPiSessionArchiveRow | undefined;
}

/**
 * 标记数据库归档已回写成本地 Pi session 文件。
 *
 * @param sessionId - chat_sessions.id。
 */
export async function markChatSessionPiSessionArchiveRestored(
  sessionId: string,
): Promise<void> {
  await getDbPool().query(
    `UPDATE chat_sessions
     SET pi_session_archive_restored_at = NOW()
     WHERE id = $1`,
    [sessionId],
  );
}

/**
 * 为当前用户拥有的会话生成或复用分享令牌。
 *
 * @param input.userId - 会话归属用户。
 * @param input.sessionId - chat_sessions.id。
 * @param input.shareToken - 首次分享时写入的随机令牌。
 * @returns 更新后的会话；无权限或会话不存在时返回 undefined。
 */
export async function shareOwnedChatSession(input: {
  userId: string;
  sessionId: string;
  shareToken: string;
}): Promise<ChatSession | undefined> {
  const { rows } = await getDbPool().query(
    `UPDATE chat_sessions
     SET share_token = COALESCE(share_token, $3),
         share_created_at = COALESCE(share_created_at, NOW())
     WHERE id = $1
       AND user_id = $2
       AND deleted_at IS NULL
     RETURNING *`,
    [input.sessionId, input.userId, input.shareToken],
  );
  return rows[0] as ChatSession | undefined;
}

/**
 * 通过分享令牌读取公开只读会话。
 *
 * @param token - 分享令牌。
 * @returns 未删除的分享会话；令牌无效时返回 undefined。
 */
export async function getSharedChatSessionByToken(
  token: string,
): Promise<ChatSession | undefined> {
  const { rows } = await getDbPool().query(
    `SELECT * FROM chat_sessions
     WHERE share_token = $1
       AND deleted_at IS NULL
     LIMIT 1`,
    [token],
  );
  return rows[0] as ChatSession | undefined;
}

export async function resetUserMessages(userId: string): Promise<string[]> {
  const now = new Date().toISOString();
  const userAccounts = await getAccountsByUserId(userId);
  const accountIds = Array.from(
    new Set([...userAccounts.map((a) => a.id), `web:${userId}`]),
  );

  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE messages
       SET deleted_at = $1
       WHERE deleted_at IS NULL
         AND (
           user_id = $2
           OR account_id = ANY($3::text[])
         )`,
      [now, userId, accountIds],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return accountIds;
}
