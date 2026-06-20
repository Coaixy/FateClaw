import crypto from 'node:crypto';

import { getDbPool } from '../db-pool.js';
import type { ClientFollowUp } from '../../shared/types.js';

const pool = {
  query(sql: string, params?: unknown[]) {
    return getDbPool().query(sql, params);
  },
};

/** 跟进记录列清单，用于 SELECT 与 INSERT 的 RETURNING 子句。 */
const CLIENT_FOLLOW_UP_COLUMNS = `
  id,
  user_id,
  client_id,
  content,
  created_at,
  deleted_at
`;

/** 创建跟进记录时可写入的字段。 */
export interface CreateClientFollowUpInput {
  userId: string;
  clientId: string;
  content: string;
}

/**
 * 创建一条客户跟进记录。
 *
 * @param input 归属用户、关联客户与正文。
 * @returns 新建的跟进记录行。
 * @remarks id 以 cfu- 前缀生成；归属与父客户校验由上层 service 负责。
 */
export async function createClientFollowUp(
  input: CreateClientFollowUpInput,
): Promise<ClientFollowUp> {
  const id = `cfu-${crypto.randomUUID()}`;
  const { rows } = await pool.query(
    `INSERT INTO client_follow_ups (id, user_id, client_id, content)
     VALUES ($1, $2, $3, $4)
     RETURNING ${CLIENT_FOLLOW_UP_COLUMNS}`,
    [id, input.userId, input.clientId, input.content],
  );
  return rows[0] as ClientFollowUp;
}

/**
 * 读取某客户的全部在档跟进记录，按创建时间倒序（最新在前）。
 *
 * @param clientId 关联客户档案 ID。
 * @param userId 跟进记录归属用户 ID（owner 隔离）。
 * @returns 跟进记录列表。
 */
export async function getClientFollowUpsByClientId(
  clientId: string,
  userId: string,
): Promise<ClientFollowUp[]> {
  const { rows } = await pool.query(
    `SELECT ${CLIENT_FOLLOW_UP_COLUMNS}
     FROM client_follow_ups
     WHERE client_id = $1 AND user_id = $2 AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [clientId, userId],
  );
  return rows as ClientFollowUp[];
}

/**
 * 软删除属于指定卦师的跟进记录。
 *
 * @param id 跟进记录 ID。
 * @param userId 归属用户 ID（owner 隔离）。
 * @returns 是否实际删除到一行。
 */
export async function softDeleteClientFollowUp(
  id: string,
  userId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE client_follow_ups
     SET deleted_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}
