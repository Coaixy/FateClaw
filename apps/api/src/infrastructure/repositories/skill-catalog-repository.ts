import { getDbPool, type DbQueryable } from '#infrastructure/db-pool';

export interface SkillGlobalConfig {
  skill_name: string;
  globally_enabled: boolean;
  updated_at: string;
  updated_by: string | null;
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
  db: DbQueryable = getDbPool(),
): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT skill_name FROM skill_global_config
     WHERE globally_enabled = true
     ORDER BY skill_name`,
  );
  return (rows as { skill_name: string }[]).map((row) => row.skill_name);
}

export interface MarketSkillListRow {
  id: string;
  skill_name: string;
  description: string;
  category: string;
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
    `SELECT s.id, s.skill_name, s.description, s.category,
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
        b.stat_skill_count::int AS skill_count
     FROM skill_bundles b
     WHERE ${conditions.join(' AND ')}
       AND b.stat_skill_count > 0
     ORDER BY b.stat_skill_count DESC, b.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return rows as MarketBundleListRow[];
}
