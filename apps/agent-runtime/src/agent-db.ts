/**
 * agent-runtime 直连数据库。
 * 替代原先通过 IPC 文件同步的方式，所有数据实时从 DB 查询。
 */

import pg from 'pg';

import { resolveEvidenceCategoryBySkill } from './evidence-policy.js';

const { Pool } = pg;
const WEB_CHAT_RUNTIME_PREFIX = 'web:';

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
  source: 'self' | 'subscribed';
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
       AND s.deleted_at IS NULL AND s.visibility IN ('link_shared', 'shared') AND s.install_status = 'installed'
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
    [userId, skillBundleFilter],
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

interface StoredToolContextEntry {
  skill: string;
  output: string;
  artifactType?: string;
  artifactTitle?: string;
  artifactData?: unknown;
}

function parseStoredToolContext(raw: string | null | undefined): StoredToolContextEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const entry = item as Record<string, unknown>;
      if (typeof entry.skill !== 'string' || typeof entry.output !== 'string') {
        return [];
      }
      return [{
        skill: entry.skill,
        output: entry.output,
        artifactType:
          typeof entry.artifactType === 'string' ? entry.artifactType : undefined,
        artifactTitle:
          typeof entry.artifactTitle === 'string' ? entry.artifactTitle : undefined,
        artifactData: entry.artifactData,
      }];
    });
  } catch {
    return [];
  }
}

export interface FollowupWorkflowContext {
  category: string;
  interpretationOutput: string;
  boardSkill?: string;
  boardOutput?: string;
  boardArtifactData?: unknown;
}

export async function queryLatestFollowupWorkflowContext(args: {
  accountId: string;
  category?: string;
  sessionId?: string;
}): Promise<FollowupWorkflowContext | null> {
  const params: unknown[] = [args.accountId];
  const conditions = [
    'account_id = $1',
    'deleted_at IS NULL',
    'is_bot_message = true',
  ];

  if (args.sessionId) {
    params.push(args.sessionId);
    conditions.push(`session_id = $${params.length}`);
  } else {
    conditions.push('session_id IS NULL');
  }

  const { rows } = await getPool().query(
    `SELECT content, tool_context
     FROM messages
     WHERE ${conditions.join(' AND ')}
     ORDER BY timestamp DESC
     LIMIT 20`,
    params,
  );

  const context: FollowupWorkflowContext = {
    category: args.category ?? '',
    interpretationOutput: '',
  };

  for (const row of rows as Array<{
    content: string | null;
    tool_context: string | null;
  }>) {
    const toolContext = parseStoredToolContext(row.tool_context);

    if (!context.interpretationOutput) {
      context.interpretationOutput =
        typeof row.content === 'string' ? row.content : '';
    }

    if (!context.boardSkill) {
      const board = toolContext.find(
        (entry) => {
          const category = resolveEvidenceCategoryBySkill(entry.skill);
          return Boolean(
            category && (!args.category || category === args.category),
          );
        },
      );
      if (board) {
        context.category =
          args.category ?? resolveEvidenceCategoryBySkill(board.skill) ?? '';
        context.boardSkill = board.skill;
        context.boardOutput = board.output;
        context.boardArtifactData = board.artifactData;
      }
    }

    if (context.interpretationOutput && context.boardSkill) {
      return context;
    }
  }

  return (context.category && context.interpretationOutput) || context.boardSkill
    ? context
    : null;
}
