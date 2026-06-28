import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { ApiKeyDto, ApiKeyStatus } from '@fateclaw/contracts/api-keys';
import { API_KEY_LIVE_PREFIX } from '@fateclaw/contracts/api-keys';

import { getDbPool } from '../db-pool.js';

/**
 * user_api_keys 表行（含敏感字段 user_id / key_hash，**不可直接对外返回**）。
 *
 * @remarks pg 对 TIMESTAMPTZ 默认返回 Date 对象，故时间字段为 Date；转 DTO 时序列化为 ISO 字符串。
 */
export interface UserApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  last_four: string;
  status: ApiKeyStatus;
  expires_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
}

/**
 * 计算 API Key 明文的存储哈希。
 *
 * @param plaintext 完整明文 key（含 fc_live_ 前缀）。
 * @returns 完整 64 位十六进制 sha256。鉴权时按此列反查；服务端只存哈希，绝不落明文。
 * @remarks 用完整 64 位，不可截断——截断会显著增大碰撞面、削弱安全性。
 */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext.trim()).digest('hex');
}

/** 生成一个新的明文 key 及其脱敏后 4 位。 */
function generateApiKeyPlaintext(): { plaintext: string; lastFour: string } {
  // 32 字节随机熵 → base64url（URL 安全、无填充字符），拼上环境前缀构成完整明文。
  const secret = randomBytes(32).toString('base64url');
  const plaintext = `${API_KEY_LIVE_PREFIX}${secret}`;
  return { plaintext, lastFour: secret.slice(-4) };
}

/**
 * 把表行转为对外脱敏 DTO，剔除 key_hash / user_id 等敏感字段。
 *
 * @param row 数据库行。
 * @returns 仅含可公开字段的 {@link ApiKeyDto}。
 */
export function toApiKeyDto(row: UserApiKeyRow): ApiKeyDto {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    last_four: row.last_four,
    status: row.status,
    last_used_at: row.last_used_at ? row.last_used_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    expires_at: row.expires_at ? row.expires_at.toISOString() : null,
  };
}

/**
 * 创建一个用户 API Key。
 *
 * @param input userId 归属用户、name 名称、expiresAt 可选过期时间（ISO 字符串）。
 * @returns 新建行与**明文 key**；明文仅此一次可得，调用方回传给用户后必须丢弃。
 */
export async function createUserApiKey(input: {
  userId: string;
  name: string;
  expiresAt?: string | null;
}): Promise<{ row: UserApiKeyRow; plaintext: string }> {
  const { plaintext, lastFour } = generateApiKeyPlaintext();
  const id = randomUUID();
  const { rows } = await getDbPool().query<UserApiKeyRow>(
    `INSERT INTO user_api_keys
       (id, user_id, name, key_prefix, key_hash, last_four, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      id,
      input.userId,
      input.name,
      API_KEY_LIVE_PREFIX,
      hashApiKey(plaintext),
      lastFour,
      input.expiresAt ?? null,
    ],
  );
  return { row: rows[0]!, plaintext };
}

/** 列出某用户的全部 API Key（含已吊销，按创建时间倒序）。 */
export async function listUserApiKeys(
  userId: string,
): Promise<UserApiKeyRow[]> {
  const { rows } = await getDbPool().query<UserApiKeyRow>(
    `SELECT * FROM user_api_keys
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

/** 统计某用户当前有效（active）的 API Key 数量，用于生成时的上限校验。 */
export async function countActiveUserApiKeys(userId: string): Promise<number> {
  const { rows } = await getDbPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM user_api_keys
      WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );
  return Number(rows[0]?.count ?? '0');
}

/**
 * 按明文哈希查找有效 API Key（鉴权用）。
 *
 * @param keyHash {@link hashApiKey} 的结果。
 * @returns 命中且 status='active' 的行；未命中返回 null。过期判断交由调用方（中间件）。
 */
export async function findActiveApiKeyByHash(
  keyHash: string,
): Promise<UserApiKeyRow | null> {
  const { rows } = await getDbPool().query<UserApiKeyRow>(
    `SELECT * FROM user_api_keys
      WHERE key_hash = $1 AND status = 'active'
      LIMIT 1`,
    [keyHash],
  );
  return rows[0] ?? null;
}

/**
 * 吊销某用户名下的一个 API Key。
 *
 * @returns 是否实际吊销了一行；false 表示 key 不存在 / 不归属该用户 / 已吊销。
 */
export async function revokeUserApiKey(input: {
  userId: string;
  keyId: string;
}): Promise<boolean> {
  const { rowCount } = await getDbPool().query(
    `UPDATE user_api_keys
        SET status = 'revoked', revoked_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'active'`,
    [input.keyId, input.userId],
  );
  return (rowCount ?? 0) > 0;
}

/** 更新 key 的最近使用时间。节流由调用方（中间件）控制，本函数只负责写库。 */
export async function touchApiKeyLastUsed(keyId: string): Promise<void> {
  await getDbPool().query(
    `UPDATE user_api_keys SET last_used_at = NOW() WHERE id = $1`,
    [keyId],
  );
}
