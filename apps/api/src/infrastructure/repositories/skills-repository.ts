import crypto from 'node:crypto';
import pg from 'pg';

import { getDbPool } from '../db-pool.js';
import {
  getSkillMarkdownMetadata,
  getTextSkillBundleContentLength,
  readTextSkillBundleFiles,
  writeTextSkillBundleFiles,
} from '../../modules/skills/text-skill-bundle-store.js';
import type {
  EffectiveUserSkill,
  SkillAccessInvite,
  SkillAccessInviteTargetType,
  SkillBundle,
  TextSkillBundleFile,
  UserCustomSkill,
  UserSkillSubscription,
} from '../../shared/types.js';

const pool = {
  query(sql: string, params?: unknown[]) {
    return getDbPool().query(sql, params);
  },
  connect() {
    return getDbPool().connect();
  },
};

interface SkillDbQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

export interface SkillGlobalConfig {
  skill_name: string;
  globally_enabled: boolean;
  updated_at: string;
  updated_by: string | null;
}

/** 私密授权链接当前能否继续领取的状态。 */
export type SkillAccessInviteStatus =
  | 'active'
  | 'expired'
  | 'revoked'
  | 'used_up';

/**
 * 私密授权链接预览结果。
 *
 * @remarks skill 与 bundle 二选一，取决于 invite.target_type。
 */
export interface SkillAccessInvitePreviewResult {
  invite: SkillAccessInvite;
  status: SkillAccessInviteStatus;
  skill: UserCustomSkill | null;
  bundle: BundleByTokenResult | null;
}

/** 领取私密授权链接后的领域状态。 */
export type RedeemSkillAccessInviteStatus =
  | 'redeemed'
  | 'invalid'
  | 'expired'
  | 'revoked'
  | 'used_up'
  | 'own_target';

/**
 * 领取私密授权链接的结果。
 *
 * @remarks 非 redeemed 状态只用于路由层返回对应错误文案。
 */
export interface RedeemSkillAccessInviteResult {
  status: RedeemSkillAccessInviteStatus;
  targetType: SkillAccessInviteTargetType | null;
  subscribedCount: number;
  skippedCount: number;
  subscriptionIds: string[];
}

/** 返回所有后台全局开启的系统排盘名称列表 */
export async function getGloballyEnabledSkillNames(): Promise<string[]> {
  const { rows } = await getDbPool().query(
    'SELECT skill_name FROM skill_global_config WHERE globally_enabled = true ORDER BY skill_name',
  );
  return (rows as { skill_name: string }[]).map((r) => r.skill_name);
}

/** 获取所有系统排盘的全局配置。 */
export async function getAllSkillGlobalConfigs(): Promise<SkillGlobalConfig[]> {
  const { rows } = await getDbPool().query(
    'SELECT skill_name, globally_enabled, updated_at, updated_by FROM skill_global_config ORDER BY skill_name',
  );
  return rows as SkillGlobalConfig[];
}

/** 后台设置系统排盘的全局开关 */
export async function setSkillGlobalEnabled(
  skillName: string,
  enabled: boolean,
): Promise<void> {
  await getDbPool().query(
    'UPDATE skill_global_config SET globally_enabled = $1, updated_at = NOW() WHERE skill_name = $2',
    [enabled, skillName],
  );
}

/**
 * 将系统排盘列表同步到 skill_global_config 表。
 * 使用 ON CONFLICT DO NOTHING，已有的条目（含开关状态）不会被覆盖。
 * 在读取兼容 catalog 或后台管理接口时调用，确保新增系统排盘自动入库。
 */
export async function seedOfficialSkills(skillNames: string[]): Promise<void> {
  if (skillNames.length === 0) return;
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    for (const name of skillNames) {
      await client.query(
        `INSERT INTO skill_global_config (skill_name, globally_enabled, updated_at)
         VALUES ($1, true, NOW())
         ON CONFLICT (skill_name) DO NOTHING`,
        [name],
      );
    }
    const placeholders = skillNames.map((_, i) => `$${i + 1}`).join(',');
    await client.query(
      `DELETE FROM skill_global_config WHERE skill_name NOT IN (${placeholders})`,
      skillNames,
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 解析用户当前可用的系统排盘名称列表。
 * 用户侧不再单独覆盖，始终跟随后台全局开关。
 */
export async function getResolvedEnabledOfficialSkillNames(
  _userId?: string,
): Promise<string[]> {
  const { rows } = await getDbPool().query(
    `SELECT skill_name FROM skill_global_config
     WHERE globally_enabled = true
     ORDER BY skill_name`,
  );
  return (rows as { skill_name: string }[]).map((row) => row.skill_name);
}

/**
 * 获取用户的有效 skill 列表（自有 + 订阅），用于 IPC 同步。
 */
export async function getEffectiveUserSkills(
  userId: string,
): Promise<EffectiveUserSkill[]> {
  const { rows } = await getDbPool().query(
    `SELECT s.id, s.dir_name as dir, s.skill_name as name, s.description,
            s.bundle_uri, s.checksum, s.install_status, s.visibility,
            'self' as source
     FROM user_custom_skills s
     WHERE s.user_id = $1 AND s.enabled = true AND s.deleted_at IS NULL AND s.install_status = 'installed'
     UNION ALL
    SELECT s.id, s.dir_name as dir, s.skill_name as name, s.description,
            s.bundle_uri, s.checksum, s.install_status, s.visibility,
            'subscribed' as source
     FROM user_skill_subscriptions sub
     JOIN user_custom_skills s ON s.id = sub.skill_id
     WHERE sub.subscriber_id = $1 AND sub.enabled = true AND sub.status = 'active'
       AND (sub.expires_at IS NULL OR sub.expires_at > NOW())
       AND s.deleted_at IS NULL
       AND (
         s.visibility IN ('link_shared', 'shared')
         OR sub.source_kind IN ('invite', 'bundle_invite')
       )
       AND s.install_status = 'installed'`,
    [userId],
  );
  return rows as EffectiveUserSkill[];
}

export interface MarketSkillListRow {
  id: string;
  skill_name: string;
  description: string;
  stat_subscriber_count: number;
  share_token: string | null;
}

const MAX_MARKET_OFFSET = 10_000;

function clampMarketPagination(opts: {
  limit: number | undefined;
  offset: number | undefined;
  defaultLimit: number;
  maxLimit: number;
}): { limit: number; offset: number } {
  const limit =
    Number.isFinite(opts.limit) && opts.limit && opts.limit > 0
      ? Math.min(Math.floor(opts.limit), opts.maxLimit)
      : opts.defaultLimit;
  const offset =
    Number.isFinite(opts.offset) && opts.offset && opts.offset > 0
      ? Math.min(Math.floor(opts.offset), MAX_MARKET_OFFSET)
      : 0;
  return { limit, offset };
}

export async function listMarketSkills(opts: {
  limit?: number;
  offset?: number;
}): Promise<MarketSkillListRow[]> {
  const conditions = ['s.deleted_at IS NULL', "s.visibility = 'shared'"];
  const params: unknown[] = [];
  // 路由层已经拒绝异常分页值；仓库层再兜底，避免内部调用绕过校验导致慢查询。
  const pagination = clampMarketPagination({
    limit: opts.limit,
    offset: opts.offset,
    defaultLimit: 50,
    maxLimit: 100,
  });
  params.push(pagination.limit, pagination.offset);
  const { rows } = await getDbPool().query(
    `SELECT s.id, s.skill_name, s.description,
            s.stat_subscriber_count,
            s.stat_view_count, s.share_token
     FROM user_custom_skills s
     WHERE ${conditions.join(' AND ')}
     ORDER BY s.stat_subscriber_count DESC, s.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows as MarketSkillListRow[];
}

export interface MarketBundleListRow {
  id: string;
  name: string;
  description: string;
  skill_count: number;
  bundle_token: string;
}

export async function listMarketBundles(opts: {
  limit?: number;
  offset?: number;
}): Promise<MarketBundleListRow[]> {
  const conditions = [
    'b.deleted_at IS NULL',
    "b.visibility = 'shared'",
    'b.bundle_token IS NOT NULL',
  ];
  const params: unknown[] = [];

  // Bundle 市场同样只允许小窗口翻页，避免公开接口被大 offset 拖慢数据库。
  const pagination = clampMarketPagination({
    limit: opts.limit,
    offset: opts.offset,
    defaultLimit: 20,
    maxLimit: 50,
  });
  params.push(pagination.limit, pagination.offset);

  const { rows } = await getDbPool().query(
    `SELECT
        b.id,
        b.name,
        b.description,
        b.bundle_token,
        COUNT(s.id)::int AS skill_count
     FROM skill_bundles b
     LEFT JOIN skill_bundle_items sbi ON sbi.bundle_id = b.id
     LEFT JOIN user_custom_skills s
       ON s.id = sbi.skill_id
      AND s.deleted_at IS NULL
      AND s.visibility IN ('link_shared', 'shared')
     WHERE ${conditions.join(' AND ')}
     GROUP BY b.id, b.name, b.description, b.bundle_token, b.created_at
     HAVING COUNT(s.id) > 0
     ORDER BY COUNT(s.id) DESC, b.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return rows as MarketBundleListRow[];
}

const USER_CUSTOM_SKILL_SELECT_COLUMNS = `
  s.id,
  s.user_id,
  s.skill_name,
  s.dir_name,
  s.description,
  s.version,
  s.bundle_uri,
  s.checksum,
  s.install_status,
  s.acl,
  s.billing_policy,
  s.audit_metadata,
  s.visibility,
  s.share_token,
  s.enabled,
  s.stat_subscriber_count,
  s.stat_view_count,
  s.created_at,
  s.updated_at,
  s.deleted_at
`;

function hydrateUserCustomSkillContent<T extends Partial<UserCustomSkill>>(
  skill: T,
): T {
  const files = readTextSkillBundleFiles(skill.bundle_uri);
  return {
    ...skill,
    files,
    content_length: files.reduce((sum, file) => sum + file.content.length, 0),
  };
}

function hydrateUserCustomSkillRows<T extends Partial<UserCustomSkill>>(
  rows: T[],
): T[] {
  return rows.map(hydrateUserCustomSkillContent);
}

const SKILL_BUNDLE_SELECT_COLUMNS = `
  b.id,
  b.user_id,
  b.name,
  b.description,
  COALESCE(
    (
      SELECT array_agg(sbi.skill_id ORDER BY sbi.sort_order)
      FROM skill_bundle_items sbi
      WHERE sbi.bundle_id = b.id
    ),
    ARRAY[]::text[]
  ) AS skill_ids,
  b.bundle_token,
  b.visibility,
  b.created_at,
  b.updated_at,
  b.deleted_at
`;

async function getActiveUserSkillSubscriptionIdUsing(
  queryable: SkillDbQueryable,
  subscriberId: string,
  skillId: string,
): Promise<string | null> {
  const { rows } = await queryable.query(
    `SELECT id
     FROM user_skill_subscriptions
     WHERE subscriber_id = $1
       AND skill_id = $2
       AND status = 'active'
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [subscriberId, skillId],
  );
  return (rows[0] as { id?: string } | undefined)?.id ?? null;
}

// =====================
// --- User custom skill accessors ---
// =====================

export interface CreateUserCustomSkillInput {
  id: string;
  user_id: string;
  skill_name: string;
  dir_name: string;
  files: TextSkillBundleFile[];
}

export async function createUserCustomSkill(
  skill: CreateUserCustomSkillInput,
): Promise<UserCustomSkill> {
  const skillFile = skill.files.find((file) => file.path === 'SKILL.md');
  const metadata = getSkillMarkdownMetadata(
    skillFile?.content ?? '',
    skill.skill_name,
  );
  const displayName = metadata.name || skill.skill_name;
  const bundle = writeTextSkillBundleFiles({
    skillId: skill.id,
    ownerId: skill.user_id,
    dirName: skill.dir_name,
    fallbackSkillName: displayName,
    files: skill.files,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO user_custom_skills
         (id, user_id, skill_name, dir_name, description,
          version, bundle_uri, checksum, install_status, acl, billing_policy, audit_metadata,
          visibility)
       VALUES ($1, $2, $3, $4, $5, '1.0.0', $6, $7, 'installed',
               '{}'::jsonb, '{}'::jsonb, $8::jsonb, 'private')`,
      [
        skill.id,
        skill.user_id,
        displayName,
        skill.dir_name,
        metadata.description,
        bundle.bundleUri,
        bundle.checksum,
        JSON.stringify({
          source: 'api',
          created_at: new Date().toISOString(),
        }),
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return (await getUserCustomSkillById(skill.id)) as UserCustomSkill;
}

export async function getUserCustomSkills(
  userId: string,
): Promise<UserCustomSkill[]> {
  const { rows } = await pool.query(
    `SELECT ${USER_CUSTOM_SKILL_SELECT_COLUMNS}
     FROM user_custom_skills s
     WHERE s.user_id = $1 AND s.deleted_at IS NULL
     ORDER BY s.created_at DESC`,
    [userId],
  );
  return hydrateUserCustomSkillRows(rows as UserCustomSkill[]);
}

export async function getUserCustomSkill(
  id: string,
  userId: string,
): Promise<UserCustomSkill | undefined> {
  const { rows } = await pool.query(
    `SELECT ${USER_CUSTOM_SKILL_SELECT_COLUMNS}
     FROM user_custom_skills s
     WHERE s.id = $1 AND s.user_id = $2 AND s.deleted_at IS NULL`,
    [id, userId],
  );
  return rows[0]
    ? hydrateUserCustomSkillContent(rows[0] as UserCustomSkill)
    : undefined;
}

export async function getUserCustomSkillById(
  id: string,
): Promise<UserCustomSkill | undefined> {
  const { rows } = await pool.query(
    `SELECT ${USER_CUSTOM_SKILL_SELECT_COLUMNS}
     FROM user_custom_skills s
     WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [id],
  );
  return rows[0]
    ? hydrateUserCustomSkillContent(rows[0] as UserCustomSkill)
    : undefined;
}

export async function updateUserCustomSkill(
  id: string,
  userId: string,
  updates: Partial<Pick<UserCustomSkill, 'skill_name' | 'dir_name' | 'files'>>,
): Promise<UserCustomSkill | undefined> {
  const skillFields: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  const allowed = ['skill_name', 'dir_name'] as const;
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      skillFields.push(`${key} = $${paramIdx++}`);
      values.push(updates[key]);
    }
  }
  const fileValue = updates.files;
  if (skillFields.length === 0 && fileValue === undefined) {
    return getUserCustomSkill(id, userId);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: currentRows } = await client.query<UserCustomSkill>(
      `SELECT ${USER_CUSTOM_SKILL_SELECT_COLUMNS}
       FROM user_custom_skills s
       WHERE s.id = $1 AND s.user_id = $2 AND s.deleted_at IS NULL
       FOR UPDATE`,
      [id, userId],
    );
    const current = currentRows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return undefined;
    }

    if (skillFields.length > 0) {
      skillFields.push(`updated_at = NOW()`);
      values.push(id, userId);
      await client.query(
        `UPDATE user_custom_skills SET ${skillFields.join(', ')}
         WHERE id = $${paramIdx++} AND user_id = $${paramIdx} AND deleted_at IS NULL`,
        values,
      );
    }
    if (fileValue !== undefined) {
      const updatedDir =
        typeof updates.dir_name === 'string'
          ? updates.dir_name
          : current.dir_name;
      const fallbackName =
        typeof updates.skill_name === 'string'
          ? updates.skill_name
          : current.skill_name;
      const skillFile = fileValue.find((file) => file.path === 'SKILL.md');
      const metadata = getSkillMarkdownMetadata(
        skillFile?.content ?? '',
        fallbackName,
      );
      const displayName = metadata.name || fallbackName;
      const bundle = writeTextSkillBundleFiles({
        skillId: id,
        ownerId: userId,
        dirName: updatedDir,
        fallbackSkillName: displayName,
        files: fileValue,
      });
      await client.query(
        `UPDATE user_custom_skills
         SET skill_name = $1,
             description = $2,
             bundle_uri = $3,
             checksum = $4,
             install_status = 'installed',
             audit_metadata = COALESCE(audit_metadata, '{}'::jsonb) || $5::jsonb,
             updated_at = NOW()
         WHERE id = $6 AND user_id = $7 AND deleted_at IS NULL`,
        [
          displayName,
          metadata.description,
          bundle.bundleUri,
          bundle.checksum,
          JSON.stringify({ updated_bundle_at: new Date().toISOString() }),
          id,
          userId,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getUserCustomSkill(id, userId);
}

export async function deleteUserCustomSkill(
  id: string,
  userId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    'UPDATE user_custom_skills SET deleted_at = NOW() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function toggleUserCustomSkill(
  id: string,
  userId: string,
): Promise<UserCustomSkill | undefined> {
  const { rowCount } = await pool.query(
    `UPDATE user_custom_skills SET enabled = NOT enabled, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getUserCustomSkill(id, userId);
}

export async function setUserCustomSkillAdminState(
  id: string,
  updates: {
    enabled?: boolean;
    visibility?: UserCustomSkill['visibility'];
    shareToken?: string | null;
  },
): Promise<UserCustomSkill | undefined> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (updates.enabled !== undefined) {
    fields.push(`enabled = $${paramIdx++}`);
    values.push(updates.enabled);
  }

  if (updates.visibility !== undefined) {
    const visibilityParamIdx = paramIdx++;
    values.push(updates.visibility);
    const shareTokenParamIdx = paramIdx++;
    values.push(updates.shareToken ?? null);
    fields.push(`visibility = $${visibilityParamIdx}`);
    fields.push(`share_token = CASE
      WHEN $${visibilityParamIdx} = 'private' THEN NULL
      WHEN $${visibilityParamIdx} IN ('link_shared', 'shared')
        THEN COALESCE(share_token, $${shareTokenParamIdx})
      ELSE share_token
    END`);
  }

  if (fields.length === 0) {
    return getUserCustomSkillById(id);
  }

  fields.push('updated_at = NOW()');
  values.push(id);

  const { rows } = await pool.query(
    `UPDATE user_custom_skills
     SET ${fields.join(', ')}
     WHERE id = $${paramIdx} AND deleted_at IS NULL
     RETURNING id`,
    values,
  );
  if (rows.length === 0) return undefined;
  return getUserCustomSkillById(id);
}

export async function getUserCustomSkillCount(userId: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT COUNT(*) as cnt FROM user_custom_skills WHERE user_id = $1 AND deleted_at IS NULL',
    [userId],
  );
  return Number((rows[0] as { cnt: string }).cnt);
}

// --- Share ---

export async function shareUserCustomSkill(
  id: string,
  userId: string,
  shareToken: string,
): Promise<UserCustomSkill | undefined> {
  const { rowCount } = await pool.query(
    `UPDATE user_custom_skills
     SET visibility = CASE WHEN visibility = 'shared' THEN 'shared' ELSE 'link_shared' END,
         share_token = COALESCE(share_token, $3),
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId, shareToken],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getUserCustomSkill(id, userId);
}

export async function unshareUserCustomSkill(
  id: string,
  userId: string,
): Promise<UserCustomSkill | undefined> {
  const { rowCount } = await pool.query(
    `UPDATE user_custom_skills
     SET visibility = CASE WHEN visibility = 'shared' THEN 'shared' ELSE 'private' END,
         share_token = CASE WHEN visibility = 'shared' THEN share_token ELSE NULL END,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getUserCustomSkill(id, userId);
}

export async function publishUserCustomSkill(
  id: string,
  userId: string,
  shareToken: string,
): Promise<UserCustomSkill | undefined> {
  const { rowCount } = await pool.query(
    `UPDATE user_custom_skills
     SET visibility = 'shared',
         share_token = COALESCE(share_token, $3),
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId, shareToken],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getUserCustomSkill(id, userId);
}

export async function unpublishUserCustomSkill(
  id: string,
  userId: string,
): Promise<UserCustomSkill | undefined> {
  const { rowCount } = await pool.query(
    `UPDATE user_custom_skills
     SET visibility = CASE WHEN share_token IS NULL THEN 'private' ELSE 'link_shared' END,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getUserCustomSkill(id, userId);
}

export async function getSkillByShareToken(
  token: string,
): Promise<UserCustomSkill | undefined> {
  const { rows } = await pool.query(
    `SELECT ${USER_CUSTOM_SKILL_SELECT_COLUMNS}
     FROM user_custom_skills s
      WHERE s.share_token = $1 AND s.deleted_at IS NULL AND s.visibility IN ('link_shared', 'shared')`,
    [token],
  );
  return rows[0]
    ? hydrateUserCustomSkillContent(rows[0] as UserCustomSkill)
    : undefined;
}

function rowToSkillAccessInvite(
  row: Record<string, unknown>,
): SkillAccessInvite {
  return row as unknown as SkillAccessInvite;
}

/**
 * 解析私密授权链接状态。
 *
 * @param invite 私密授权链接行。
 * @param now 用于测试或事务内复用的当前时间。
 * @returns 当前链接是否仍可领取。
 */
export function resolveSkillAccessInviteStatus(
  invite: SkillAccessInvite,
  now = new Date(),
): SkillAccessInviteStatus {
  if (invite.revoked_at) return 'revoked';
  if (
    invite.expires_at &&
    new Date(invite.expires_at).getTime() <= now.getTime()
  ) {
    return 'expired';
  }
  if (invite.redeemed_count >= invite.max_redemptions) return 'used_up';
  return 'active';
}

async function getUserCustomSkillByIdUsing(
  queryable: SkillDbQueryable,
  id: string,
): Promise<UserCustomSkill | undefined> {
  const { rows } = await queryable.query(
    `SELECT ${USER_CUSTOM_SKILL_SELECT_COLUMNS}
     FROM user_custom_skills s
     WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [id],
  );
  return rows[0]
    ? hydrateUserCustomSkillContent(rows[0] as UserCustomSkill)
    : undefined;
}

async function getSkillBundleWithSkillsByIdUsing(
  queryable: SkillDbQueryable,
  id: string,
): Promise<BundleByTokenResult | undefined> {
  const { rows } = await queryable.query(
    `SELECT ${SKILL_BUNDLE_SELECT_COLUMNS}
     FROM skill_bundles b
     WHERE b.id = $1 AND b.deleted_at IS NULL`,
    [id],
  );
  if (rows.length === 0) return undefined;
  const bundle = rowToSkillBundle(rows[0] as Record<string, unknown>);
  if (bundle.skill_ids.length === 0) {
    return { bundle, skills: [] };
  }

  const { rows: skillRows } = await queryable.query(
    `SELECT s.id, s.skill_name, s.description, s.bundle_uri
     FROM user_custom_skills s
     WHERE s.id = ANY($1) AND s.deleted_at IS NULL`,
    [bundle.skill_ids],
  );
  const byId = new Map(
    (skillRows as Array<Record<string, unknown>>).map((row) => [
      row.id as string,
      row,
    ]),
  );
  const skills = bundle.skill_ids
    .map((skillId) => byId.get(skillId))
    .filter((row): row is Record<string, unknown> => Boolean(row))
    .map((row) => ({
      id: row.id as string,
      skill_name: row.skill_name as string,
      description: row.description as string,
      content_length: getTextSkillBundleContentLength(row.bundle_uri as string),
    }));

  return { bundle, skills };
}

/**
 * 创建私密授权链接所需的 repository 输入。
 */
export interface CreateSkillAccessInviteInput {
  id: string;
  creatorId: string;
  targetType: SkillAccessInviteTargetType;
  targetId: string;
  token: string;
  maxRedemptions: number;
  expiresAt: string | null;
  note: string;
}

/**
 * 为作者自有 Skill 或 Bundle 创建私密授权链接。
 *
 * @returns 目标不存在或不属于作者时返回 null。
 */
export async function createSkillAccessInvite(
  input: CreateSkillAccessInviteInput,
): Promise<SkillAccessInvite | null> {
  const target =
    input.targetType === 'skill'
      ? await getUserCustomSkill(input.targetId, input.creatorId)
      : await getSkillBundleById(input.targetId, input.creatorId);
  if (!target) return null;

  const { rows } = await pool.query(
    `INSERT INTO skill_access_invites (
       id, creator_id, target_type, target_id, token,
       max_redemptions, expires_at, note
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.id,
      input.creatorId,
      input.targetType,
      input.targetId,
      input.token,
      input.maxRedemptions,
      input.expiresAt,
      input.note,
    ],
  );
  return rowToSkillAccessInvite(rows[0] as Record<string, unknown>);
}

/**
 * 作者侧授权链接列表筛选条件。
 */
export interface ListSkillAccessInvitesFilter {
  targetType?: SkillAccessInviteTargetType;
  targetId?: string;
}

/**
 * 列出作者创建的私密授权链接。
 */
export async function listSkillAccessInvites(
  creatorId: string,
  filter: ListSkillAccessInvitesFilter = {},
): Promise<SkillAccessInvite[]> {
  const conditions = ['creator_id = $1'];
  const params: unknown[] = [creatorId];
  if (filter.targetType) {
    params.push(filter.targetType);
    conditions.push(`target_type = $${params.length}`);
  }
  if (filter.targetId) {
    params.push(filter.targetId);
    conditions.push(`target_id = $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT *
     FROM skill_access_invites
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    params,
  );
  return (rows as Array<Record<string, unknown>>).map(rowToSkillAccessInvite);
}

/**
 * 撤销作者创建的私密授权链接。
 *
 * @returns 链接不存在或不属于作者时返回 null。
 */
export async function revokeSkillAccessInvite(
  inviteId: string,
  creatorId: string,
): Promise<SkillAccessInvite | null> {
  const { rows } = await pool.query(
    `UPDATE skill_access_invites
     SET revoked_at = COALESCE(revoked_at, NOW())
     WHERE id = $1 AND creator_id = $2
     RETURNING *`,
    [inviteId, creatorId],
  );
  return rows[0]
    ? rowToSkillAccessInvite(rows[0] as Record<string, unknown>)
    : null;
}

async function getSkillAccessInviteByTokenUsing(
  queryable: SkillDbQueryable,
  token: string,
  forUpdate = false,
): Promise<SkillAccessInvite | null> {
  const { rows } = await queryable.query(
    `SELECT *
     FROM skill_access_invites
     WHERE token = $1
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [token],
  );
  return rows[0]
    ? rowToSkillAccessInvite(rows[0] as Record<string, unknown>)
    : null;
}

/**
 * 读取私密授权链接预览。
 *
 * @returns 链接或目标不存在时返回 null。
 */
export async function getSkillAccessInvitePreviewByToken(
  token: string,
): Promise<SkillAccessInvitePreviewResult | null> {
  const invite = await getSkillAccessInviteByTokenUsing(pool, token);
  if (!invite) return null;
  const status = resolveSkillAccessInviteStatus(invite);

  if (invite.target_type === 'skill') {
    const skill = await getUserCustomSkillByIdUsing(pool, invite.target_id);
    if (!skill) return null;
    return { invite, status, skill, bundle: null };
  }

  const bundle = await getSkillBundleWithSkillsByIdUsing(
    pool,
    invite.target_id,
  );
  if (!bundle) return null;
  return { invite, status, skill: null, bundle };
}

/**
 * 领取私密授权链接，并写入用户 Skill 订阅。
 */
export async function redeemSkillAccessInvite(
  subscriberId: string,
  token: string,
): Promise<RedeemSkillAccessInviteResult> {
  const client = await pool.connect();
  const inactiveResult = (
    status: RedeemSkillAccessInviteStatus,
    targetType: SkillAccessInviteTargetType | null,
  ): RedeemSkillAccessInviteResult => ({
    status,
    targetType,
    subscribedCount: 0,
    skippedCount: 0,
    subscriptionIds: [],
  });

  try {
    await client.query('BEGIN');
    const invite = await getSkillAccessInviteByTokenUsing(client, token, true);
    if (!invite) {
      await client.query('ROLLBACK');
      return inactiveResult('invalid', null);
    }

    const inviteStatus = resolveSkillAccessInviteStatus(invite);
    if (inviteStatus !== 'active') {
      await client.query('ROLLBACK');
      return inactiveResult(inviteStatus, invite.target_type);
    }

    if (invite.target_type === 'skill') {
      const skill = await getUserCustomSkillByIdUsing(client, invite.target_id);
      if (!skill) {
        await client.query('ROLLBACK');
        return inactiveResult('invalid', 'skill');
      }
      if (skill.user_id === subscriberId) {
        await client.query('ROLLBACK');
        return inactiveResult('own_target', 'skill');
      }

      const subscriptionId = crypto.randomUUID();
      const { rows } = await client.query(
        `INSERT INTO user_skill_subscriptions
           (id, subscriber_id, skill_id, has_direct_source, source_kind)
         VALUES ($1, $2, $3, true, 'invite')
         ON CONFLICT (subscriber_id, skill_id) DO UPDATE SET
           enabled = true,
           status = 'active',
           expires_at = NULL,
           has_direct_source = true,
           source_kind = 'invite'
         RETURNING id, (xmax = 0) AS is_insert`,
        [subscriptionId, subscriberId, skill.id],
      );
      const row = rows[0] as { id: string; is_insert: boolean };
      if (row.is_insert) {
        await client.query(
          `UPDATE user_custom_skills
           SET stat_subscriber_count = stat_subscriber_count + 1,
               updated_at = NOW()
           WHERE id = $1`,
          [skill.id],
        );
      }
      await client.query(
        `UPDATE skill_access_invites
         SET redeemed_count = redeemed_count + 1
         WHERE id = $1`,
        [invite.id],
      );
      await client.query('COMMIT');
      return {
        status: 'redeemed',
        targetType: 'skill',
        subscribedCount: row.is_insert ? 1 : 0,
        skippedCount: row.is_insert ? 0 : 1,
        subscriptionIds: [row.id],
      };
    }

    const bundle = await getSkillBundleWithSkillsByIdUsing(
      client,
      invite.target_id,
    );
    if (!bundle) {
      await client.query('ROLLBACK');
      return inactiveResult('invalid', 'bundle');
    }
    if (bundle.bundle.user_id === subscriberId) {
      await client.query('ROLLBACK');
      return inactiveResult('own_target', 'bundle');
    }

    const skillIdsValid = bundle.skills.map((skill) => skill.id);
    let skippedCount = bundle.bundle.skill_ids.length - skillIdsValid.length;
    let subscribedCount = 0;
    const subscriptionIds: string[] = [];
    const insertedSkillIds = new Set<string>();

    for (const skillId of skillIdsValid) {
      const subId = crypto.randomUUID();
      const { rows, rowCount } = await client.query(
        `INSERT INTO user_skill_subscriptions
           (id, subscriber_id, skill_id, has_direct_source, source_kind)
         VALUES ($1, $2, $3, false, 'bundle_invite')
         ON CONFLICT (subscriber_id, skill_id) DO UPDATE SET
           enabled = true,
           status = 'active',
           expires_at = NULL,
           source_kind = CASE
             WHEN user_skill_subscriptions.source_kind = 'invite'
               THEN 'invite'
             ELSE 'bundle_invite'
           END
         RETURNING id, (xmax = 0) AS is_insert`,
        [subId, subscriberId, skillId],
      );
      const row = rows[0] as { id: string; is_insert: boolean } | undefined;
      const subscriptionId =
        rowCount && rowCount > 0 && row
          ? row.id
          : await getActiveUserSkillSubscriptionIdUsing(
              client,
              subscriberId,
              skillId,
            );
      if (!subscriptionId) {
        skippedCount++;
        continue;
      }
      await client.query(
        `INSERT INTO user_skill_subscription_bundle_sources
           (subscription_id, bundle_id)
         VALUES ($1, $2)
         ON CONFLICT (subscription_id, bundle_id) DO NOTHING`,
        [subscriptionId, bundle.bundle.id],
      );
      if (row?.is_insert) {
        subscribedCount++;
        subscriptionIds.push(subscriptionId);
        insertedSkillIds.add(skillId);
      } else {
        skippedCount++;
      }
    }

    if (insertedSkillIds.size > 0) {
      await client.query(
        `UPDATE user_custom_skills
         SET stat_subscriber_count = stat_subscriber_count + 1,
             updated_at = NOW()
         WHERE id = ANY($1)`,
        [Array.from(insertedSkillIds)],
      );
    }
    await client.query(
      `UPDATE skill_access_invites
       SET redeemed_count = redeemed_count + 1
       WHERE id = $1`,
      [invite.id],
    );
    await client.query('COMMIT');
    return {
      status: 'redeemed',
      targetType: 'bundle',
      subscribedCount,
      skippedCount,
      subscriptionIds,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// --- Subscription ---

export async function subscribeToSkill(
  subscriptionId: string,
  subscriberId: string,
  shareToken: string,
): Promise<UserSkillSubscription | null> {
  // 查找分享的 skill
  const skill = await getSkillByShareToken(shareToken);
  if (!skill) return null;
  // 不能订阅自己的 skill
  if (skill.user_id === subscriberId) return null;

  const { rows } = await pool.query(
    `INSERT INTO user_skill_subscriptions (id, subscriber_id, skill_id, source_kind)
     VALUES ($1, $2, $3, 'share')
     ON CONFLICT (subscriber_id, skill_id) DO UPDATE SET
       enabled = true,
       has_direct_source = true,
       source_kind = CASE
         WHEN user_skill_subscriptions.source_kind IN ('invite', 'bundle_invite')
           THEN user_skill_subscriptions.source_kind
         ELSE 'share'
       END
     RETURNING *, (xmax = 0) AS is_insert`,
    [subscriptionId, subscriberId, skill.id],
  );
  if (rows[0] && (rows[0] as Record<string, unknown>).is_insert) {
    await pool.query(
      `UPDATE user_custom_skills
       SET stat_subscriber_count = stat_subscriber_count + 1,
           updated_at = NOW()
       WHERE id = $1`,
      [skill.id],
    );
  }
  return rows[0] as UserSkillSubscription;
}

export async function unsubscribeFromSkill(
  subscriptionId: string,
  subscriberId: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    'DELETE FROM user_skill_subscriptions WHERE id = $1 AND subscriber_id = $2 RETURNING skill_id',
    [subscriptionId, subscriberId],
  );
  if (rows.length > 0) {
    await pool.query(
      `UPDATE user_custom_skills SET stat_subscriber_count = GREATEST(0, stat_subscriber_count - 1), updated_at = NOW() WHERE id = $1`,
      [(rows[0] as { skill_id: string }).skill_id],
    );
    return true;
  }
  return false;
}

export async function toggleSubscription(
  subscriptionId: string,
  subscriberId: string,
): Promise<boolean | null> {
  const { rows } = await pool.query(
    `UPDATE user_skill_subscriptions SET enabled = NOT enabled
     WHERE id = $1 AND subscriber_id = $2
     RETURNING enabled`,
    [subscriptionId, subscriberId],
  );
  if (rows.length === 0) return null;
  return (rows[0] as { enabled: boolean }).enabled;
}

export async function getSubscribedSkills(subscriberId: string): Promise<
  (UserCustomSkill & {
    subscription_id: string;
    subscription_enabled: boolean;
    has_direct_source: boolean;
    source_bundles: Array<{ id: string; name: string }>;
  })[]
> {
  const { rows } = await pool.query(
    `SELECT ${USER_CUSTOM_SKILL_SELECT_COLUMNS},
            sub.id as subscription_id,
            sub.enabled as subscription_enabled,
            sub.has_direct_source,
            COALESCE(
              (
                SELECT jsonb_agg(
                  jsonb_build_object('id', b.id, 'name', b.name)
                  ORDER BY src.created_at ASC
                )
                FROM user_skill_subscription_bundle_sources src
                JOIN skill_bundles b ON b.id = src.bundle_id
                WHERE src.subscription_id = sub.id
              ),
              '[]'::jsonb
            ) AS source_bundles
     FROM user_skill_subscriptions sub
     JOIN user_custom_skills s ON s.id = sub.skill_id
     WHERE sub.subscriber_id = $1
       AND sub.status = 'active'
       AND (sub.expires_at IS NULL OR sub.expires_at > NOW())
       AND s.deleted_at IS NULL
       AND (
         s.visibility IN ('link_shared', 'shared')
         OR sub.source_kind IN ('invite', 'bundle_invite')
       )`,
    [subscriberId],
  );
  return hydrateUserCustomSkillRows(
    rows as (UserCustomSkill & {
      subscription_id: string;
      subscription_enabled: boolean;
      has_direct_source: boolean;
      source_bundles: Array<{ id: string; name: string }>;
    })[],
  );
}

/** 获取订阅某个 skill 的所有用户 ID */
export async function getSubscriberIds(skillId: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT subscriber_id
     FROM user_skill_subscriptions
     WHERE skill_id = $1
       AND enabled = true
       AND status = 'active'
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [skillId],
  );
  return (rows as { subscriber_id: string }[]).map((r) => r.subscriber_id);
}

// =====================
// --- Skill Bundles ---
// =====================

/** 把 DB 原始行（skill_ids 为 text[] / JSON 字符串或数组）规范化为 SkillBundle */
function rowToSkillBundle(row: Record<string, unknown>): SkillBundle {
  const raw = row.skill_ids;
  const skillIds = Array.isArray(raw)
    ? (raw as unknown[]).map((value) => String(value))
    : typeof raw === 'string'
      ? (JSON.parse(raw) as string[])
      : [];
  return { ...(row as unknown as SkillBundle), skill_ids: skillIds };
}

async function getSkillBundleById(
  id: string,
  userId?: string,
): Promise<SkillBundle | undefined> {
  const params: unknown[] = [id];
  let whereClause = `WHERE b.id = $1 AND b.deleted_at IS NULL`;
  if (userId) {
    params.push(userId);
    whereClause += ` AND b.user_id = $2`;
  }
  const { rows } = await pool.query(
    `SELECT ${SKILL_BUNDLE_SELECT_COLUMNS}
     FROM skill_bundles b
     ${whereClause}`,
    params,
  );
  return rows[0]
    ? rowToSkillBundle(rows[0] as Record<string, unknown>)
    : undefined;
}

async function validateBundleSkillOwnershipUsing(
  client: pg.PoolClient,
  userId: string,
  skillIds: string[],
): Promise<string[]> {
  const unique = Array.from(new Set(skillIds));
  if (unique.length === 0) throw new Error('bundle 至少包含 1 个技能');
  const { rows } = await client.query<{ cnt: string }>(
    `SELECT COUNT(*) as cnt FROM user_custom_skills
     WHERE id = ANY($1) AND user_id = $2 AND deleted_at IS NULL`,
    [unique, userId],
  );
  if (Number(rows[0].cnt) !== unique.length) {
    throw new Error('bundle 包含非法 skill');
  }
  return unique;
}

async function replaceSkillBundleItemsUsing(
  client: pg.PoolClient,
  bundleId: string,
  skillIds: string[],
): Promise<void> {
  await client.query(`DELETE FROM skill_bundle_items WHERE bundle_id = $1`, [
    bundleId,
  ]);
  await client.query(
    `INSERT INTO skill_bundle_items (bundle_id, skill_id, sort_order)
     SELECT $1, items.skill_id, (items.ordinality - 1)::int
     FROM UNNEST($2::text[]) WITH ORDINALITY AS items(skill_id, ordinality)`,
    [bundleId, skillIds],
  );
}

export async function createSkillBundle(
  id: string,
  userId: string,
  name: string,
  description: string,
  skillIds: string[],
): Promise<SkillBundle> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const unique = await validateBundleSkillOwnershipUsing(
      client,
      userId,
      skillIds,
    );
    await client.query(
      `INSERT INTO skill_bundles (id, user_id, name, description)
       VALUES ($1, $2, $3, $4)`,
      [id, userId, name, description],
    );
    await replaceSkillBundleItemsUsing(client, id, unique);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return (await getSkillBundleById(id, userId)) as SkillBundle;
}

export async function listUserBundles(userId: string): Promise<SkillBundle[]> {
  const { rows } = await pool.query(
    `SELECT ${SKILL_BUNDLE_SELECT_COLUMNS}
     FROM skill_bundles b
     WHERE user_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [userId],
  );
  return (rows as Record<string, unknown>[]).map(rowToSkillBundle);
}

export async function updateSkillBundle(
  id: string,
  userId: string,
  patch: { name?: string; description?: string; skill_ids?: string[] },
): Promise<SkillBundle | undefined> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (patch.name !== undefined) {
    fields.push(`name = $${idx++}`);
    values.push(patch.name);
  }
  if (patch.description !== undefined) {
    fields.push(`description = $${idx++}`);
    values.push(patch.description);
  }
  if (fields.length === 0 && patch.skill_ids === undefined) {
    return getSkillBundleById(id, userId);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let exists = false;
    if (fields.length > 0) {
      fields.push(`updated_at = NOW()`);
      values.push(id, userId);
      const result = await client.query(
        `UPDATE skill_bundles SET ${fields.join(', ')}
         WHERE id = $${idx++} AND user_id = $${idx} AND deleted_at IS NULL`,
        values,
      );
      exists = (result.rowCount ?? 0) > 0;
    } else {
      const { rowCount } = await client.query(
        `SELECT 1 FROM skill_bundles
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [id, userId],
      );
      exists = (rowCount ?? 0) > 0;
    }
    if (!exists) {
      await client.query('ROLLBACK');
      return undefined;
    }
    if (patch.skill_ids !== undefined) {
      const unique = await validateBundleSkillOwnershipUsing(
        client,
        userId,
        patch.skill_ids,
      );
      await replaceSkillBundleItemsUsing(client, id, unique);
      if (fields.length === 0) {
        await client.query(
          `UPDATE skill_bundles
           SET updated_at = NOW()
           WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [id, userId],
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getSkillBundleById(id, userId);
}

export async function deleteSkillBundle(
  id: string,
  userId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE skill_bundles SET deleted_at = NOW(), bundle_token = NULL, visibility = 'private'
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function shareSkillBundle(
  id: string,
  userId: string,
  token: string,
): Promise<SkillBundle | undefined> {
  const { rowCount } = await pool.query(
    `UPDATE skill_bundles
     SET visibility = CASE WHEN visibility = 'shared' THEN 'shared' ELSE 'link_shared' END,
         bundle_token = COALESCE(bundle_token, $3),
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId, token],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getSkillBundleById(id, userId);
}

export async function unshareSkillBundle(
  id: string,
  userId: string,
): Promise<SkillBundle | undefined> {
  const { rowCount } = await pool.query(
    `UPDATE skill_bundles
     SET visibility = CASE WHEN visibility = 'shared' THEN 'shared' ELSE 'private' END,
         bundle_token = CASE WHEN visibility = 'shared' THEN bundle_token ELSE NULL END,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getSkillBundleById(id, userId);
}

export async function publishSkillBundle(
  id: string,
  userId: string,
  token: string,
): Promise<SkillBundle | undefined> {
  const { rowCount } = await pool.query(
    `UPDATE skill_bundles
     SET visibility = 'shared',
         bundle_token = COALESCE(bundle_token, $3),
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId, token],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getSkillBundleById(id, userId);
}

export async function unpublishSkillBundle(
  id: string,
  userId: string,
): Promise<SkillBundle | undefined> {
  const { rowCount } = await pool.query(
    `UPDATE skill_bundles
     SET visibility = CASE WHEN bundle_token IS NULL THEN 'private' ELSE 'link_shared' END,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getSkillBundleById(id, userId);
}

export interface BundleByTokenResult {
  bundle: SkillBundle;
  skills: Array<{
    id: string;
    skill_name: string;
    description: string;
    content_length: number;
  }>;
}

export async function getBundleByToken(
  token: string,
): Promise<BundleByTokenResult | undefined> {
  const { rows } = await pool.query(
    `SELECT ${SKILL_BUNDLE_SELECT_COLUMNS}
     FROM skill_bundles b
     WHERE b.bundle_token = $1 AND b.deleted_at IS NULL AND b.visibility IN ('link_shared', 'shared')`,
    [token],
  );
  if (rows.length === 0) return undefined;
  const row = rows[0] as Record<string, unknown>;
  const bundle = rowToSkillBundle(row);
  if (bundle.skill_ids.length === 0) {
    return {
      bundle,
      skills: [],
    };
  }
  const { rows: skillRows } = await pool.query(
    `SELECT s.id, s.skill_name, s.description, s.bundle_uri
     FROM user_custom_skills s
     WHERE s.id = ANY($1) AND s.deleted_at IS NULL AND s.visibility IN ('link_shared', 'shared')`,
    [bundle.skill_ids],
  );
  // 保留 bundle.skill_ids 原始顺序
  const byId = new Map(
    (skillRows as Array<Record<string, unknown>>).map((r) => [
      r.id as string,
      r,
    ]),
  );
  const skills = bundle.skill_ids
    .map((sid) => byId.get(sid))
    .filter((x): x is Record<string, unknown> => Boolean(x))
    .map((r) => ({
      id: r.id as string,
      skill_name: r.skill_name as string,
      description: r.description as string,
      content_length: getTextSkillBundleContentLength(r.bundle_uri as string),
    }));
  return {
    bundle,
    skills,
  };
}

export interface SubscribeToBundleResult {
  subscribedCount: number;
  skippedCount: number;
  subscriptionIds: string[];
}

export async function subscribeToBundle(
  subscriberId: string,
  token: string,
): Promise<SubscribeToBundleResult | null> {
  const info = await getBundleByToken(token);
  if (!info) return null;
  if (info.bundle.user_id === subscriberId) return null; // 非自订

  const skillIdsValid = info.skills.map((s) => s.id);
  // getBundleByToken 内部已过滤失效（deleted_at / visibility）。
  // bundle.skill_ids 原始长度 - 有效长度 = 静默跳过的失效条数
  let skippedCount = info.bundle.skill_ids.length - skillIdsValid.length;
  let subscribedCount = 0;
  const subscriptionIds: string[] = [];
  const insertedSkillIds = new Set<string>();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const skillId of skillIdsValid) {
      const subId = crypto.randomUUID();
      const { rows, rowCount } = await client.query(
        `INSERT INTO user_skill_subscriptions
           (id, subscriber_id, skill_id, has_direct_source, source_kind)
         VALUES ($1, $2, $3, false, 'bundle_share')
         ON CONFLICT (subscriber_id, skill_id) DO NOTHING
         RETURNING id`,
        [subId, subscriberId, skillId],
      );
      const subscriptionId =
        rowCount && rowCount > 0
          ? (rows[0] as { id: string }).id
          : await getActiveUserSkillSubscriptionIdUsing(
              client,
              subscriberId,
              skillId,
            );
      if (!subscriptionId) {
        skippedCount++;
        continue;
      }
      await client.query(
        `INSERT INTO user_skill_subscription_bundle_sources
           (subscription_id, bundle_id)
         VALUES ($1, $2)
         ON CONFLICT (subscription_id, bundle_id) DO NOTHING`,
        [subscriptionId, info.bundle.id],
      );
      if (rowCount && rowCount > 0) {
        subscribedCount++;
        subscriptionIds.push(subscriptionId);
        insertedSkillIds.add(skillId);
      } else {
        skippedCount++;
      }
    }
    if (insertedSkillIds.size > 0) {
      await client.query(
        `UPDATE user_custom_skills
         SET stat_subscriber_count = stat_subscriber_count + 1,
             updated_at = NOW()
         WHERE id = ANY($1)`,
        [Array.from(insertedSkillIds)],
      );
    }
    await client.query('COMMIT');
    return { subscribedCount, skippedCount, subscriptionIds };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function unsubscribeFromBundle(
  bundleId: string,
  subscriberId: string,
): Promise<number> {
  const { rows } = await pool.query(
    `WITH affected AS (
       SELECT sub.id, sub.skill_id
       FROM user_skill_subscriptions sub
       JOIN user_skill_subscription_bundle_sources src
         ON src.subscription_id = sub.id
       WHERE sub.subscriber_id = $1 AND src.bundle_id = $2
     ),
     deleted_sources AS (
       DELETE FROM user_skill_subscription_bundle_sources src
       USING affected a
       WHERE src.subscription_id = a.id AND src.bundle_id = $2
       RETURNING src.subscription_id
     ),
     removable AS (
       SELECT sub.id, sub.skill_id
       FROM user_skill_subscriptions sub
       JOIN affected a ON a.id = sub.id
       WHERE sub.has_direct_source = false
         AND NOT EXISTS (
           SELECT 1
           FROM user_skill_subscription_bundle_sources src
           WHERE src.subscription_id = sub.id
         )
     ),
     deleted_subscriptions AS (
       DELETE FROM user_skill_subscriptions sub
       USING removable r
       WHERE sub.id = r.id
       RETURNING sub.skill_id
     ),
     decrements AS (
       SELECT skill_id, COUNT(*)::int AS count
       FROM deleted_subscriptions
       GROUP BY skill_id
     ),
     updated AS (
       UPDATE user_custom_skills s
       SET stat_subscriber_count = GREATEST(0, s.stat_subscriber_count - d.count),
           updated_at = NOW()
       FROM decrements d
       WHERE s.id = d.skill_id
       RETURNING s.id
     )
     SELECT
       (SELECT COUNT(*)::int FROM deleted_sources) AS deleted_source_count,
       COALESCE((SELECT SUM(count)::int FROM decrements), 0) AS deleted_count`,
    [subscriberId, bundleId],
  );
  return Number(
    (rows[0] as { deleted_source_count: number | string }).deleted_source_count,
  );
}
