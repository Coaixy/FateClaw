import type { WechatChatSessionLink } from '#shared/types';
import { getDbPool } from '#infrastructure/db-pool';

/**
 * 读取微信 sender 当前接续的网页 AI Chat 会话。
 *
 * @param accountId - 微信 Claw 账号 ID。
 * @param senderHash - 去标识化后的微信发送方哈希。
 * @returns 当前接续映射；不存在时返回 undefined。
 */
export async function getWechatChatSessionLink(
  accountId: string,
  senderHash: string,
): Promise<WechatChatSessionLink | undefined> {
  const { rows } = await getDbPool().query(
    `SELECT *
     FROM wechat_chat_session_links
     WHERE account_id = $1 AND sender_hash = $2
     LIMIT 1`,
    [accountId, senderHash],
  );
  return rows[0] as WechatChatSessionLink | undefined;
}

/**
 * 创建或更新微信 sender 到网页 AI Chat 会话的接续映射。
 *
 * @param input - 接续映射字段。
 * @returns 写入后的接续映射。
 */
export async function upsertWechatChatSessionLink(input: {
  accountId: string;
  senderHash: string;
  userId: string;
  sessionId: string;
}): Promise<WechatChatSessionLink> {
  const { rows } = await getDbPool().query(
    `INSERT INTO wechat_chat_session_links (
       account_id, sender_hash, user_id, session_id
     )
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, sender_hash)
     DO UPDATE SET
       user_id = EXCLUDED.user_id,
       session_id = EXCLUDED.session_id,
       updated_at = NOW(),
       last_used_at = NOW()
     RETURNING *`,
    [input.accountId, input.senderHash, input.userId, input.sessionId],
  );
  return rows[0] as WechatChatSessionLink;
}

/**
 * 更新微信 sender 接续映射的最近使用时间。
 *
 * @param accountId - 微信 Claw 账号 ID。
 * @param senderHash - 去标识化后的微信发送方哈希。
 */
export async function touchWechatChatSessionLink(
  accountId: string,
  senderHash: string,
): Promise<void> {
  await getDbPool().query(
    `UPDATE wechat_chat_session_links
     SET last_used_at = NOW(), updated_at = NOW()
     WHERE account_id = $1 AND sender_hash = $2`,
    [accountId, senderHash],
  );
}

/**
 * 解除微信 sender 当前接续的网页 AI Chat 会话。
 *
 * @param accountId - 微信 Claw 账号 ID。
 * @param senderHash - 去标识化后的微信发送方哈希。
 * @returns 实际删除映射时返回 true。
 */
export async function deleteWechatChatSessionLink(
  accountId: string,
  senderHash: string,
): Promise<boolean> {
  const { rowCount } = await getDbPool().query(
    `DELETE FROM wechat_chat_session_links
     WHERE account_id = $1 AND sender_hash = $2`,
    [accountId, senderHash],
  );
  return (rowCount ?? 0) > 0;
}
