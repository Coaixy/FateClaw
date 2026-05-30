import { User, UserRole } from '../../shared/types.js';
import type { DbQueryable } from '../db-pool.js';
import { getDbPool } from '../db-pool.js';
import { queryOne, queryRows } from '../typed-query.js';

const USER_SELECT_COLUMNS = `
  u.id,
  u.phone,
  u.phone_verified,
  u.password_hash,
  u.role,
  u.purchased_coins,
  u.bonus_coins,
  u.reserved_coins,
  u.soul_content,
  u.created_at
`;

export async function getUserByIdUsing(
  queryable: DbQueryable,
  id: string,
  opts?: { forUpdate?: boolean },
): Promise<User | undefined> {
  const forUpdateClause = opts?.forUpdate ? ' FOR UPDATE OF u' : '';
  return queryOne<User>(
    queryable,
    `SELECT ${USER_SELECT_COLUMNS}
     FROM users u
     WHERE u.id = $1${forUpdateClause}`,
    [id],
  );
}

export async function getUserByPhoneUsing(
  queryable: DbQueryable,
  phone: string,
): Promise<User | undefined> {
  return queryOne<User>(
    queryable,
    `SELECT ${USER_SELECT_COLUMNS}
     FROM users u
     WHERE u.phone = $1`,
    [phone],
  );
}

export async function createUser(user: User): Promise<void> {
  await getDbPool().query(
    `INSERT INTO users
       (id, phone, phone_verified, password_hash, role,
        purchased_coins, bonus_coins, reserved_coins,
        created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      user.id,
      user.phone,
      user.phone_verified,
      user.password_hash,
      user.role,
      user.purchased_coins,
      user.bonus_coins,
      user.reserved_coins,
      user.created_at,
    ],
  );
}

export async function getAllUsers(): Promise<User[]> {
  return queryRows<User>(
    getDbPool(),
    `SELECT ${USER_SELECT_COLUMNS}
     FROM users u
     ORDER BY u.created_at DESC`,
  );
}

export async function getUserById(id: string): Promise<User | undefined> {
  return getUserByIdUsing(getDbPool(), id);
}

export async function getUserByPhone(phone: string): Promise<User | undefined> {
  return getUserByPhoneUsing(getDbPool(), phone);
}

export async function updateUserPasswordHash(
  userId: string,
  passwordHash: string,
): Promise<User> {
  await getDbPool().query('UPDATE users SET password_hash = $1 WHERE id = $2', [
    passwordHash,
    userId,
  ]);
  const user = await getUserById(userId);
  if (!user) {
    throw new Error('用户不存在');
  }
  return user;
}

/**
 * 读取用户级 Soul 自定义人格。
 *
 * 用户级 Soul 独立于微信账号，主要服务站内 AI Chat 的 web runtime。
 */
export async function getUserSoulContent(userId: string): Promise<string> {
  const row = await queryOne<{ soul_content: string | null }>(
    getDbPool(),
    'SELECT soul_content FROM users WHERE id = $1',
    [userId],
  );
  return row?.soul_content ?? '';
}

/**
 * 更新用户级 Soul 自定义人格。
 *
 * 调用方必须已完成用户身份校验，避免跨用户写入运行时人格。
 */
export async function updateUserSoulContent(
  userId: string,
  content: string,
): Promise<void> {
  await getDbPool().query('UPDATE users SET soul_content = $1 WHERE id = $2', [
    content,
    userId,
  ]);
}

export async function getUserByAccountId(
  accountId: string,
): Promise<User | undefined> {
  return queryOne<User>(
    getDbPool(),
    `SELECT ${USER_SELECT_COLUMNS}
     FROM users u
     JOIN accounts a ON a.owner_id = u.id
     WHERE a.id = $1`,
    [accountId],
  );
}

export async function updateUserRole(
  userId: string,
  role: UserRole,
): Promise<void> {
  await getDbPool().query('UPDATE users SET role = $1 WHERE id = $2', [
    role,
    userId,
  ]);
}

/** 消费者申请成为创作者：consumer → both（保留消费者能力），creator → creator（幂等） */
export async function promoteUserToCreator(userId: string): Promise<UserRole> {
  const row = await queryOne<{ role: UserRole }>(
    getDbPool(),
    `UPDATE users
       SET role = CASE role
         WHEN 'consumer' THEN 'both'
         WHEN 'admin' THEN 'admin'
         ELSE role
       END
     WHERE id = $1
     RETURNING role`,
    [userId],
  );
  return row?.role ?? 'consumer';
}
