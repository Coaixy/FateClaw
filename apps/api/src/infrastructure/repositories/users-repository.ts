import { User } from '../../shared/types.js';
import type { DbQueryable } from '../db-pool.js';
import { getDbPool } from '../db-pool.js';
import { queryOne } from '../typed-query.js';

const USER_SELECT_COLUMNS = `
  u.id,
  u.phone,
  u.phone_verified,
  u.password_hash,
  u.auth_token_version,
  u.role,
  u.purchased_coins::float8 AS purchased_coins,
  u.bonus_coins::float8 AS bonus_coins,
  u.reserved_coins::float8 AS reserved_coins,
  u.soul_content,
  u.soul_edit_enabled,
  u.created_at
`;

export type OAuthProvider = 'google';

export interface OAuthIdentityInput {
  provider: OAuthProvider;
  providerUserId: string;
  userId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  profileJson: Record<string, unknown>;
}

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

/**
 * 按第三方身份读取绑定的用户。
 *
 * @param queryable 查询执行器；可传事务 client 保证 OAuth 回调内的一致性。
 * @param provider 第三方登录提供方，目前仅支持 Google。
 * @param providerUserId 提供方稳定用户 ID，例如 Google `sub`。
 * @returns 已绑定用户；未绑定时返回 undefined。
 */
export async function getUserByOAuthIdentityUsing(
  queryable: DbQueryable,
  provider: OAuthProvider,
  providerUserId: string,
): Promise<User | undefined> {
  return queryOne<User>(
    queryable,
    `SELECT ${USER_SELECT_COLUMNS}
     FROM users u
     JOIN user_oauth_identities identity ON identity.user_id = u.id
     WHERE identity.provider = $1
       AND identity.provider_user_id = $2`,
    [provider, providerUserId],
  );
}

export async function createUser(user: User): Promise<void> {
  await createUserUsing(getDbPool(), user);
}

/**
 * 在指定 queryable 上创建用户。
 *
 * 用于注册时把用户创建和邀请关系绑定放进同一个数据库事务。
 */
export async function createUserUsing(
  queryable: DbQueryable,
  user: User,
): Promise<void> {
  await queryable.query(
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

/**
 * 写入或刷新第三方身份资料。
 *
 * @param queryable 查询执行器；OAuth 注册时应传事务 client。
 * @param input 第三方身份资料和本地用户绑定。
 * @returns 无返回值。
 * @remarks 冲突更新时不改 user_id，避免并发或异常请求把身份转绑到其他用户。
 */
export async function upsertOAuthIdentityUsing(
  queryable: DbQueryable,
  input: OAuthIdentityInput,
): Promise<void> {
  await queryable.query(
    `INSERT INTO user_oauth_identities (
       provider, provider_user_id, user_id, email, email_verified,
       display_name, avatar_url, profile_json, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW(), NOW())
     ON CONFLICT (provider, provider_user_id) DO UPDATE SET
       email = EXCLUDED.email,
       email_verified = EXCLUDED.email_verified,
       display_name = EXCLUDED.display_name,
       avatar_url = EXCLUDED.avatar_url,
       profile_json = EXCLUDED.profile_json,
       updated_at = NOW()`,
    [
      input.provider,
      input.providerUserId,
      input.userId,
      input.email,
      input.emailVerified,
      input.displayName,
      input.avatarUrl,
      JSON.stringify(input.profileJson),
    ],
  );
}

export interface AdminUsersPageRow {
  users: User[];
  total: number;
}

/**
 * 管理后台分页查询用户，并支持按手机号或用户 ID 搜索。
 *
 * @param opts.limit 每页数量，调用方负责限制上限。
 * @param opts.offset 起始偏移。
 * @param opts.query 搜索关键词；匹配手机号或用户 ID。
 * @returns 当前页用户和匹配总数。
 */
export async function listUsersPageForAdmin(opts: {
  limit: number;
  offset: number;
  query?: string;
}): Promise<AdminUsersPageRow> {
  const where: string[] = [];
  const values: unknown[] = [];
  let index = 1;
  const trimmedQuery = opts.query?.trim();
  if (trimmedQuery) {
    // 手机号 / ID 一律按子串匹配且不区分大小写：支持搜手机号中间几位（如「23」命中「1234」），
    // 而非仅前缀。（原先纯数字/字母的查询走前缀 LIKE 'q%'，导致输入手机号中段搜不到。）
    where.push(`(u.phone ILIKE $${index} OR u.id ILIKE $${index})`);
    values.push(`%${trimmedQuery}%`);
    index += 1;
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const countValues = [...values];
  values.push(opts.limit, opts.offset);
  const { rows } = await getDbPool().query(
    `SELECT ${USER_SELECT_COLUMNS},
            COUNT(*) OVER()::int AS __total
     FROM users u
     ${whereClause}
     ORDER BY u.created_at DESC
     LIMIT $${index} OFFSET $${index + 1}`,
    values,
  );
  let total =
    rows.length > 0 ? Number((rows[0] as { __total: number }).__total) : 0;
  if (rows.length === 0 && opts.offset > 0) {
    const count = await getDbPool().query(
      `SELECT COUNT(*)::int AS total
       FROM users u
       ${whereClause}`,
      countValues,
    );
    total = Number((count.rows[0] as { total: number }).total);
  }
  return {
    users: (rows as Array<User & { __total: number }>).map(
      ({ __total: _total, ...user }) => user,
    ),
    total,
  };
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
  await getDbPool().query(
    `UPDATE users
     SET password_hash = $1,
         auth_token_version = auth_token_version + 1
     WHERE id = $2`,
    [passwordHash, userId],
  );
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
 * 读取用户级 Soul 是否允许对话编辑。
 *
 * 新老库默认都视为开启，避免迁移前后的用户行为突然变化。
 */
export async function getUserSoulEditEnabled(userId: string): Promise<boolean> {
  const row = await queryOne<{ soul_edit_enabled: boolean | null }>(
    getDbPool(),
    'SELECT soul_edit_enabled FROM users WHERE id = $1',
    [userId],
  );
  return row?.soul_edit_enabled ?? true;
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

/**
 * 更新用户级 Soul 的对话编辑权限。
 *
 * 关闭后 Pi Runtime 不再注册 edit_soul，模型无法在对话中写入 Soul。
 */
export async function updateUserSoulEditEnabled(
  userId: string,
  enabled: boolean,
): Promise<void> {
  await getDbPool().query(
    'UPDATE users SET soul_edit_enabled = $1 WHERE id = $2',
    [enabled, userId],
  );
}

/**
 * 读取用户级话术稿模板。
 *
 * 为空字符串表示该卦师未自定义,调用方据此回退到平台默认骨架。
 */
export async function getUserGuashiScriptTemplate(
  userId: string,
): Promise<string> {
  const row = await queryOne<{ guashi_script_template: string | null }>(
    getDbPool(),
    'SELECT guashi_script_template FROM users WHERE id = $1',
    [userId],
  );
  return row?.guashi_script_template ?? '';
}

/**
 * 更新用户级话术稿模板。
 *
 * 调用方必须已完成用户身份校验;存空字符串等价于恢复使用平台默认骨架。
 */
export async function updateUserGuashiScriptTemplate(
  userId: string,
  content: string,
): Promise<void> {
  await getDbPool().query(
    'UPDATE users SET guashi_script_template = $1 WHERE id = $2',
    [content, userId],
  );
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

