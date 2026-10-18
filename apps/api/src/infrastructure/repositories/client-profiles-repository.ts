import crypto from 'node:crypto';

import { getDbPool, type DbQueryable } from '#infrastructure/db-pool';
import type { ClientProfile } from '#shared/types';

const pool = {
  query(sql: string, params?: unknown[]) {
    return getDbPool().query(sql, params);
  },
};

/** 客户档案表的标准列清单，用于带表别名 c 的 SELECT/JOIN 查询。 */
const CLIENT_PROFILE_SELECT_COLUMNS = `
  c.id,
  c.user_id,
  c.name,
  c.gender,
  c.solar_date,
  c.hour,
  c.minute,
  c.birthplace,
  c.notes,
  c.tags,
  c.status,
  c.created_at,
  c.updated_at,
  c.deleted_at
`;

/** 无表别名的列清单，用于 INSERT / UPDATE 的 RETURNING 子句。 */
const CLIENT_PROFILE_RETURNING_COLUMNS = `
  id,
  user_id,
  name,
  gender,
  solar_date,
  hour,
  minute,
  birthplace,
  notes,
  tags,
  status,
  created_at,
  updated_at,
  deleted_at
`;

/**
 * 创建客户档案行时可写入的字段。
 *
 * @remarks gender 由调用方保证为 '男'/'女' 或 null；其余可空字段为空串时应在上层归一为 null。
 */
export interface CreateClientProfileInput {
  userId: string;
  name: string;
  gender?: string | null;
  solarDate?: string | null;
  hour?: number | null;
  minute?: number | null;
  birthplace?: string | null;
  notes?: string | null;
  tags?: string[];
  status?: string | null;
}

/** 更新客户档案行时可覆盖的字段；未提供（undefined）的字段保持原值。 */
export interface UpdateClientProfileInput {
  name?: string;
  gender?: string | null;
  solarDate?: string | null;
  hour?: number | null;
  minute?: number | null;
  birthplace?: string | null;
  notes?: string | null;
  tags?: string[];
  status?: string | null;
}

/**
 * 列表查询返回的客户档案行，附带该客户的解读会话聚合统计。
 *
 * @remarks session_count/last_session_at 来自 chat_sessions LEFT JOIN，无会话时分别为 0 / null。
 */
export interface ClientProfileWithStats extends ClientProfile {
  session_count: number;
  last_session_at: string | null;
}

/**
 * 创建客户档案。
 *
 * @param input 归属用户与档案字段。
 * @returns 新建的客户档案行。
 * @remarks id 以 cp- 前缀生成；唯一索引 (user_id, name) WHERE deleted_at IS NULL 会拦截重名，
 *          上层需捕获唯一冲突并转成 409。
 */
export async function createClientProfile(
  input: CreateClientProfileInput,
): Promise<ClientProfile> {
  const id = `cp-${crypto.randomUUID()}`;
  const { rows } = await pool.query(
    `INSERT INTO client_profiles
       (id, user_id, name, gender, solar_date, hour, minute, birthplace, notes, tags, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${CLIENT_PROFILE_RETURNING_COLUMNS}`,
    [
      id,
      input.userId,
      input.name,
      input.gender ?? null,
      input.solarDate ?? null,
      input.hour ?? null,
      input.minute ?? null,
      input.birthplace ?? null,
      input.notes ?? null,
      input.tags ?? [],
      input.status ?? null,
    ],
  );
  return rows[0] as ClientProfile;
}

/**
 * 读取某卦师的全部在档客户，按更新时间倒序，附带解读会话统计。
 *
 * @param userId 客户归属用户 ID。
 * @returns 客户档案列表（含 session_count/last_session_at）。
 * @remarks 仅统计未归档（deleted_at IS NULL）的会话，避免归档会话污染计数。
 */
export async function getClientProfilesByUserId(
  userId: string,
): Promise<ClientProfileWithStats[]> {
  const { rows } = await pool.query(
    `SELECT ${CLIENT_PROFILE_SELECT_COLUMNS},
            COUNT(s.id)::int AS session_count,
            MAX(s.updated_at) AS last_session_at
     FROM client_profiles c
     LEFT JOIN chat_sessions s
       ON s.client_id = c.id
      AND s.deleted_at IS NULL
     WHERE c.user_id = $1 AND c.deleted_at IS NULL
     GROUP BY c.id
     ORDER BY c.updated_at DESC`,
    [userId],
  );
  return rows as ClientProfileWithStats[];
}

/**
 * 按 id 读取属于指定卦师的在档客户。
 *
 * @param id 客户档案 ID。
 * @param userId 客户归属用户 ID（owner 隔离）。
 * @returns 命中的客户档案；不存在、已删除或不属于该用户时返回 undefined。
 */
export async function getClientProfile(
  id: string,
  userId: string,
  db: DbQueryable = getDbPool(),
): Promise<ClientProfile | undefined> {
  const { rows } = await db.query(
    `SELECT ${CLIENT_PROFILE_SELECT_COLUMNS}
     FROM client_profiles c
     WHERE c.id = $1 AND c.user_id = $2 AND c.deleted_at IS NULL`,
    [id, userId],
  );
  return rows[0] as ClientProfile | undefined;
}

/**
 * 管理员按 id 读取客户档案（不带 user 归属过滤）。
 *
 * @param id 客户档案 ID。
 * @returns 命中的客户档案；不存在或已删除时返回 undefined。
 * @remarks 仅供后台 admin 查看会话详情时附带客户信息用，无 owner 隔离。
 */
export async function getClientProfileByIdForAdmin(
  id: string,
): Promise<ClientProfile | undefined> {
  const { rows } = await pool.query(
    `SELECT ${CLIENT_PROFILE_SELECT_COLUMNS}
     FROM client_profiles c
     WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [id],
  );
  return rows[0] as ClientProfile | undefined;
}

/**
 * 更新属于指定卦师的客户档案。
 *
 * @param id 客户档案 ID。
 * @param userId 客户归属用户 ID（owner 隔离）。
 * @param updates 需要覆盖的字段；undefined 字段保持原值。
 * @returns 更新后的客户档案；不存在或无权限时返回 undefined。
 * @remarks 改名命中唯一索引时会抛唯一冲突，上层需转成 409。
 */
export async function updateClientProfile(
  id: string,
  userId: string,
  updates: UpdateClientProfileInput,
): Promise<ClientProfile | undefined> {
  // 动态拼装 SET 子句，只更新调用方显式给出的字段。
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  const assign = (column: string, value: unknown) => {
    fields.push(`${column} = $${idx++}`);
    values.push(value);
  };

  if (updates.name !== undefined) assign('name', updates.name);
  if (updates.gender !== undefined) assign('gender', updates.gender);
  if (updates.solarDate !== undefined) assign('solar_date', updates.solarDate);
  if (updates.hour !== undefined) assign('hour', updates.hour);
  if (updates.minute !== undefined) assign('minute', updates.minute);
  if (updates.birthplace !== undefined)
    assign('birthplace', updates.birthplace);
  if (updates.notes !== undefined) assign('notes', updates.notes);
  if (updates.tags !== undefined) assign('tags', updates.tags);
  if (updates.status !== undefined) assign('status', updates.status);

  // 没有任何字段变更时直接回读当前行，保持幂等。
  if (fields.length === 0) {
    return getClientProfile(id, userId);
  }

  fields.push(`updated_at = NOW()`);
  values.push(id, userId);

  const { rows } = await pool.query(
    `UPDATE client_profiles c
     SET ${fields.join(', ')}
     WHERE c.id = $${idx++} AND c.user_id = $${idx} AND c.deleted_at IS NULL
     RETURNING ${CLIENT_PROFILE_RETURNING_COLUMNS}`,
    values,
  );
  return rows[0] as ClientProfile | undefined;
}

/**
 * 软删除属于指定卦师的客户档案。
 *
 * @param id 客户档案 ID。
 * @param userId 客户归属用户 ID（owner 隔离）。
 * @returns 是否实际删除到一行。
 * @remarks 仅标记 deleted_at；已关联会话的 client_id 由外键 ON DELETE SET NULL 在物理删除时处理，
 *          软删除场景下历史会话仍保留 client_id 指向已归档档案，列表查询已按 deleted_at 过滤。
 */
export async function softDeleteClientProfile(
  id: string,
  userId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE client_profiles
     SET deleted_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}
