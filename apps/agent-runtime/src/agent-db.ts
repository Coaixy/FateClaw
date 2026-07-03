/**
 * agent-runtime 直连数据库。
 * 替代原先通过 IPC 文件同步的方式，所有数据实时从 DB 查询。
 */

import pg from 'pg';

const { Pool } = pg;
const WEB_CHAT_RUNTIME_PREFIX = 'web:';
const WORKFLOW_SNAPSHOT_AUDIT_SOURCE = 'simple_workflow_snapshot';

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('缺少 DATABASE_URL 环境变量');
    pool = new Pool({ connectionString: url });
  }
  return pool;
}

function getUserIdFromWebChatRuntimeId(value: string): string | null {
  if (!value.startsWith(WEB_CHAT_RUNTIME_PREFIX)) return null;
  const userId = value.slice(WEB_CHAT_RUNTIME_PREFIX.length).trim();
  return userId || null;
}

/** 关闭连接池（进程退出时调用） */
export async function closeAgentDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ── Skills ──

/**
 * 查询用户可用的系统排盘名称列表。
 * 用户侧不再单独覆盖，始终跟随后台全局开关。
 */
export async function queryEnabledSkillNames(_userId?: string): Promise<string[]> {
  const { rows } = await getPool().query(
    'SELECT skill_name FROM skill_global_config WHERE globally_enabled = true ORDER BY skill_name',
  );
  return (rows as { skill_name: string }[]).map((r) => r.skill_name);
}

export interface EffectiveUserSkill {
  id: string;
  dir: string;
  name: string;
  description: string;
  bundle_uri: string;
  checksum: string | null;
  install_status: 'installed' | 'missing' | 'error';
  visibility: 'private' | 'link_shared' | 'shared';
  source: 'self' | 'subscribed' | 'workflow';
  source_bundle_ids?: string[];
}

/**
 * 查询用户的有效自定义 Skill（自有 + 订阅且启用的）。
 *
 * @param userId 平台用户 ID。
 * @param options.skillBundleIds 可选的请求级 Skill Bundle 白名单；为空时返回全部有效 Skill。
 * @returns 当前用户在本轮请求中可见的自定义 Skill。
 */
export async function queryEffectiveUserSkills(
  userId: string,
  options: { skillBundleIds?: string[] } = {},
): Promise<EffectiveUserSkill[]> {
  if (!userId) return [];
  const skillBundleIds = Array.from(
    new Set(
      (options.skillBundleIds ?? [])
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  );
  const skillBundleFilter = skillBundleIds.length > 0 ? skillBundleIds : null;
  const { rows } = await getPool().query(
    `SELECT s.id, s.dir_name as dir, s.skill_name as name, s.description,
            s.bundle_uri, s.checksum, s.install_status, s.visibility,
            'self' as source,
            ARRAY(
              SELECT DISTINCT sbi.bundle_id
              FROM skill_bundle_items sbi
              JOIN skill_bundles b ON b.id = sbi.bundle_id
              WHERE sbi.skill_id = s.id
                AND b.user_id = $1
                AND b.deleted_at IS NULL
                AND ($2::text[] IS NULL OR sbi.bundle_id = ANY($2::text[]))
              ORDER BY sbi.bundle_id
            ) as source_bundle_ids
     FROM user_custom_skills s
     WHERE s.user_id = $1 AND s.enabled = true AND s.deleted_at IS NULL AND s.install_status = 'installed'
       AND COALESCE(s.audit_metadata->>'source', '') <> $3
       AND (
         $2::text[] IS NULL OR EXISTS (
           SELECT 1
           FROM skill_bundle_items sbi
           JOIN skill_bundles b ON b.id = sbi.bundle_id
           WHERE sbi.skill_id = s.id
             AND b.user_id = $1
             AND b.deleted_at IS NULL
             AND sbi.bundle_id = ANY($2::text[])
         )
       )
     UNION ALL
    SELECT s.id, s.dir_name as dir, s.skill_name as name, s.description,
            s.bundle_uri, s.checksum, s.install_status, s.visibility,
            'subscribed' as source,
            ARRAY(
              SELECT DISTINCT src.bundle_id
              FROM user_skill_subscription_bundle_sources src
              JOIN skill_bundles b ON b.id = src.bundle_id
              WHERE src.subscription_id = sub.id
                AND b.deleted_at IS NULL
                AND ($2::text[] IS NULL OR src.bundle_id = ANY($2::text[]))
              ORDER BY src.bundle_id
            ) as source_bundle_ids
     FROM user_skill_subscriptions sub
     JOIN user_custom_skills s ON s.id = sub.skill_id
     WHERE sub.subscriber_id = $1 AND sub.enabled = true AND sub.status = 'active'
       AND (sub.expires_at IS NULL OR sub.expires_at > NOW())
       AND s.deleted_at IS NULL
       AND COALESCE(s.audit_metadata->>'source', '') <> $3
       AND (
         s.visibility IN ('link_shared', 'shared')
         OR sub.source_kind IN ('bundle_share', 'invite', 'bundle_invite')
       )
       AND s.install_status = 'installed'
       AND (
         $2::text[] IS NULL OR EXISTS (
           SELECT 1
           FROM user_skill_subscription_bundle_sources src
           JOIN skill_bundles b ON b.id = src.bundle_id
           WHERE src.subscription_id = sub.id
             AND b.deleted_at IS NULL
             AND src.bundle_id = ANY($2::text[])
         )
       )`,
    [userId, skillBundleFilter, WORKFLOW_SNAPSHOT_AUDIT_SOURCE],
  );
  return rows as EffectiveUserSkill[];
}

/**
 * 按单个 Skill id 查询用户的有效自定义 Skill（自有 + 订阅且启用的）。
 *
 * @param userId 平台用户 ID。
 * @param skillIds 请求级 Skill id 白名单。
 * @returns 交集结果——只返回用户实际拥有/订阅且启用的 Skill；无权或未启用的 id 自动丢弃。
 * @remarks 复用 queryEffectiveUserSkills 的归属/启用/安装/订阅有效期校验（不加 Bundle 过滤=全量有效），
 *   再按 id 取交集；对外开放 API 用其按「单个 skill id」授权。
 */
export async function queryEffectiveUserSkillsByIds(
  userId: string,
  skillIds: string[],
): Promise<EffectiveUserSkill[]> {
  if (!userId) return [];
  const wanted = new Set(
    skillIds.map((id) => id.trim()).filter((id) => id.length > 0),
  );
  if (wanted.size === 0) return [];
  const all = await queryEffectiveUserSkills(userId);
  return all.filter((skill) => wanted.has(skill.id));
}

/**
 * 按 workflow 已授权的 Bundle ID 读取 Skill。
 *
 * @param skillBundleIds 管理后台 workflow 显式绑定的 Bundle ID 列表。
 * @returns Bundle 内已安装且启用的 Skill；不要求终端用户拥有或订阅这些 Bundle。
 * @remarks
 * 安全契约（本次审计固化，勿破坏）：本查询刻意「不做 user_id 归属过滤」——这是 workflow 需要
 * 加载平台/他人 Bundle 的特权能力，加归属会阉割其设计用途。因此安全性**完全依赖调用方保证
 * `skillBundleIds` 不可被终端用户控制**：当前 API 侧没有任何 HTTP 路由把客户端输入转发到
 * `authorizedSkillBundleIds`（仅内部 workflow / resident-agent 显式设置）。
 * 若未来新增会转发用户可控 id 的路径，必须在 API 入口做授权校验，否则此处会退化为跨账号私有
 * Skill 读取。完整封堵需为 IPC 请求引入来源认证（架构级，单独立项）。
 */
export async function queryWorkflowBundleSkills(
  skillBundleIds: string[],
): Promise<EffectiveUserSkill[]> {
  const normalized = Array.from(
    new Set(skillBundleIds.map((id) => id.trim()).filter(Boolean)),
  );
  if (normalized.length === 0) return [];

  const { rows } = await getPool().query(
    `SELECT
       s.id,
       s.dir_name as dir,
       s.skill_name as name,
       s.description,
       s.bundle_uri,
       s.checksum,
       s.install_status,
       s.visibility,
       'workflow' as source,
       array_agg(DISTINCT sbi.bundle_id ORDER BY sbi.bundle_id) as source_bundle_ids
     FROM skill_bundle_items sbi
     JOIN skill_bundles b ON b.id = sbi.bundle_id
     JOIN user_custom_skills s ON s.id = sbi.skill_id
     WHERE sbi.bundle_id = ANY($1::text[])
       AND b.deleted_at IS NULL
       AND s.enabled = true
       AND s.deleted_at IS NULL
       AND s.install_status = 'installed'
       AND COALESCE(s.audit_metadata->>'source', '') <> $2
     GROUP BY s.id, s.dir_name, s.skill_name, s.description, s.bundle_uri,
              s.checksum, s.install_status, s.visibility
     ORDER BY MIN(array_position($1::text[], sbi.bundle_id)), MIN(sbi.sort_order), s.dir_name`,
    [normalized, WORKFLOW_SNAPSHOT_AUDIT_SOURCE],
  );
  return rows as EffectiveUserSkill[];
}

/**
 * 按 workflow 保存时生成的 Skill 快照 ID 读取 Skill。
 *
 * @param skillIds 管理后台 workflow 保存时固定下来的快照 Skill ID。
 * @returns 对应快照 Skill；不再依赖原始 Bundle 分享状态或成员列表。
 */
export async function queryWorkflowSnapshotSkills(
  skillIds: string[],
): Promise<EffectiveUserSkill[]> {
  const normalized = Array.from(
    new Set(skillIds.map((id) => id.trim()).filter(Boolean)),
  );
  if (normalized.length === 0) return [];

  const { rows } = await getPool().query(
    `SELECT
       s.id,
       s.dir_name as dir,
       s.skill_name as name,
       s.description,
       s.bundle_uri,
       s.checksum,
       s.install_status,
       s.visibility,
       'workflow' as source,
       ARRAY[]::text[] as source_bundle_ids
     FROM user_custom_skills s
     WHERE s.id = ANY($1::text[])
       AND s.audit_metadata->>'source' = $2
       AND s.deleted_at IS NULL
       AND s.enabled = true
       AND s.install_status = 'installed'
     ORDER BY array_position($1::text[], s.id), s.dir_name`,
    [normalized, WORKFLOW_SNAPSHOT_AUDIT_SOURCE],
  );
  return rows as EffectiveUserSkill[];
}

// ── Soul ──

/**
 * 读取账号可见的用户级 Soul。
 *
 * @param accountId 当前 agent-runtime 账号 ID；站内 AI Chat 使用 web:{userId}。
 * @returns 可注入 Pi Runtime 的 Soul 内容；未配置时返回空字符串。
 * @remarks 用户级 Soul 优先于账号级历史 Soul，确保 Dashboard 维护的是唯一长期记忆来源。
 */
export async function querySoulContent(accountId: string): Promise<string> {
  const webUserId = getUserIdFromWebChatRuntimeId(accountId);
  if (webUserId) {
    const userSoul = await getPool().query(
      'SELECT soul_content FROM users WHERE id = $1',
      [webUserId],
    );
    const userContent =
      (userSoul.rows[0] as { soul_content: string } | undefined)
        ?.soul_content || '';
    if (userContent.trim()) return userContent;

    const { rows } = await getPool().query(
      `SELECT soul_content
       FROM accounts
       WHERE owner_id = $1
       ORDER BY enabled DESC, created_at ASC
       LIMIT 1`,
      [webUserId],
    );
    if (rows.length === 0) return '';
    return (rows[0] as { soul_content: string }).soul_content || '';
  }

  const { rows } = await getPool().query(
    `SELECT
       a.soul_content AS account_soul_content,
       u.soul_content AS user_soul_content
     FROM accounts a
     LEFT JOIN users u ON u.id = a.owner_id
     WHERE a.id = $1`,
    [accountId],
  );
  if (rows.length === 0) return '';
  const row = rows[0] as {
    account_soul_content: string | null;
    user_soul_content: string | null;
  };
  return row.user_soul_content?.trim()
    ? row.user_soul_content
    : row.account_soul_content || '';
}

/**
 * 读取当前账号对应用户是否允许 Pi 对话编辑 Soul。
 *
 * @param accountId 当前 agent-runtime 账号 ID；站内 AI Chat 使用 web:{userId}。
 * @returns true 表示本轮可以注册 edit_soul；历史账号或缺失配置默认开启。
 * @remarks 这是工具暴露层的硬权限开关，关闭时模型完全看不到 edit_soul。
 */
export async function querySoulEditEnabled(
  accountId: string,
): Promise<boolean> {
  const webUserId = getUserIdFromWebChatRuntimeId(accountId);
  if (webUserId) {
    const { rows } = await getPool().query(
      'SELECT soul_edit_enabled FROM users WHERE id = $1',
      [webUserId],
    );
    return (
      (rows[0] as { soul_edit_enabled: boolean | null } | undefined)
        ?.soul_edit_enabled ?? true
    );
  }

  const { rows } = await getPool().query(
    `SELECT COALESCE(u.soul_edit_enabled, true) AS soul_edit_enabled
     FROM accounts a
     LEFT JOIN users u ON u.id = a.owner_id
     WHERE a.id = $1`,
    [accountId],
  );
  return (
    (rows[0] as { soul_edit_enabled: boolean | null } | undefined)
      ?.soul_edit_enabled ?? true
  );
}

/**
 * 更新账号可见的用户级 Soul。
 *
 * @param accountId 当前 agent-runtime 账号 ID；站内 AI Chat 使用 web:{userId}。
 * @param content 新的完整 Soul 内容。
 * @returns 无返回值。
 * @remarks 优先写入账号所属用户的 users.soul_content；只有无 owner 的历史账号才回退写 accounts.soul_content。
 */
export async function updateSoulContentDb(
  accountId: string,
  content: string,
): Promise<void> {
  const webUserId = getUserIdFromWebChatRuntimeId(accountId);
  if (webUserId) {
    await getPool().query(
      'UPDATE users SET soul_content = $2 WHERE id = $1',
      [webUserId, content],
    );
    return;
  }

  const userUpdate = await getPool().query(
    `UPDATE users
     SET soul_content = $2
     WHERE id = (
       SELECT owner_id
       FROM accounts
       WHERE id = $1 AND owner_id IS NOT NULL
     )`,
    [accountId, content],
  );
  if ((userUpdate.rowCount ?? 0) > 0) return;

  await getPool().query(
    'UPDATE accounts SET soul_content = $2 WHERE id = $1',
    [accountId, content],
  );
}
