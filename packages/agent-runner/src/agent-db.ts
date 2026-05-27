/**
 * agent-runner 直连数据库。
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
 * 查询用户可用的官方 Skill 名称列表。
 * 当提供 userId 时，结合 user_skills 偏好和 default_enabled 决定：
 *   - 用户显式启用 → 启用
 *   - 用户显式禁用 → 禁用
 *   - 无用户偏好 → 取 default_enabled
 * 全局禁用的 skill 始终不返回。
 * 无 userId 时回退到全局 default_enabled 行为。
 */
export async function queryEnabledSkillNames(userId?: string): Promise<string[]> {
  if (userId) {
    const { rows } = await getPool().query(
      `SELECT sgc.skill_name FROM skill_global_config sgc
       LEFT JOIN user_skills us
         ON us.skill_name = sgc.skill_name AND us.user_id = $1 AND us.deleted_at IS NULL
       WHERE sgc.globally_enabled = true
         AND COALESCE(us.enabled, sgc.default_enabled) = true
       ORDER BY sgc.skill_name`,
      [userId],
    );
    return (rows as { skill_name: string }[]).map((r) => r.skill_name);
  }
  const { rows } = await getPool().query(
    'SELECT skill_name FROM skill_global_config WHERE globally_enabled = true AND default_enabled = true ORDER BY skill_name',
  );
  return (rows as { skill_name: string }[]).map((r) => r.skill_name);
}

export interface EffectiveUserSkill {
  id: string;
  dir: string;
  name: string;
  description: string;
  trigger: string;
  bundle_uri: string;
  checksum: string | null;
  install_status: 'installed' | 'missing' | 'error';
  visibility: 'private' | 'link_shared' | 'shared';
  category: string;
  category_normalized: string | null;
  match_keywords: string[];
  match_patterns: string[];
  example_queries: string[];
  priority: number;
  usage_mode: 'force_injected' | 'reference_only';
  source: 'self' | 'subscribed';
}

/**
 * 查询用户的有效自定义 Skill（自有 + 订阅且启用的）。
 */
export async function queryEffectiveUserSkills(
  userId: string,
): Promise<EffectiveUserSkill[]> {
  if (!userId) return [];
  const { rows } = await getPool().query(
    `SELECT s.id, s.dir_name as dir, s.skill_name as name, s.description, s.trigger_hint as trigger,
            s.bundle_uri, s.checksum, s.install_status, s.visibility,
            COALESCE(s.category, '通用') as category, s.category_normalized,
            s.match_keywords, s.match_patterns, s.example_queries, s.priority, s.usage_mode,
            'self' as source
     FROM user_custom_skills s
     WHERE s.user_id = $1 AND s.enabled = true AND s.deleted_at IS NULL AND s.install_status = 'installed'
     UNION ALL
    SELECT s.id, s.dir_name as dir, s.skill_name as name, s.description, s.trigger_hint as trigger,
            s.bundle_uri, s.checksum, s.install_status, s.visibility,
            COALESCE(s.category, '通用') as category, s.category_normalized,
            s.match_keywords, s.match_patterns, s.example_queries, s.priority, s.usage_mode,
            'subscribed' as source
     FROM user_skill_subscriptions sub
     JOIN user_custom_skills s ON s.id = sub.skill_id
     WHERE sub.subscriber_id = $1 AND sub.enabled = true AND sub.status = 'active'
       AND (sub.expires_at IS NULL OR sub.expires_at > NOW())
       AND s.deleted_at IS NULL AND s.visibility IN ('link_shared', 'shared') AND s.install_status = 'installed'
     UNION ALL
    SELECT s.id, s.dir_name as dir, s.skill_name as name, s.description, s.trigger_hint as trigger,
            s.bundle_uri, s.checksum, s.install_status, s.visibility,
            COALESCE(s.category, '通用') as category, s.category_normalized,
            s.match_keywords, s.match_patterns, s.example_queries, s.priority, s.usage_mode,
            'subscribed' as source
     FROM creator_bundle_subscriptions bs
     JOIN user_custom_skills s ON s.user_id = bs.creator_id
     WHERE bs.subscriber_id = $1 AND bs.status = 'active'
       AND (bs.expires_at IS NULL OR bs.expires_at > NOW())
       AND s.deleted_at IS NULL AND s.visibility IN ('link_shared', 'shared') AND s.install_status = 'installed'
       AND NOT EXISTS (
         SELECT 1 FROM user_skill_subscriptions sub2
         WHERE sub2.subscriber_id = $1 AND sub2.skill_id = s.id
       )`,
    [userId],
  );
  return rows as EffectiveUserSkill[];
}

/**
 * 启用或禁用官方 Skill（per-user）。
 */
export async function toggleUserSkill(
  userId: string,
  skillName: string,
  action: 'enable' | 'disable',
): Promise<void> {
  if (action === 'enable') {
    const now = new Date().toISOString();
    await getPool().query(
      `INSERT INTO user_skills (user_id, skill_name, enabled, enabled_at)
       VALUES ($1, $2, true, $3)
       ON CONFLICT (user_id, skill_name) DO UPDATE SET enabled = true, enabled_at = $3, deleted_at = NULL`,
      [userId, skillName, now],
    );
  } else {
    const now = new Date().toISOString();
    await getPool().query(
      `INSERT INTO user_skills (user_id, skill_name, enabled, enabled_at)
       VALUES ($1, $2, false, $3)
       ON CONFLICT (user_id, skill_name) DO UPDATE SET enabled = false, deleted_at = NULL`,
      [userId, skillName, now],
    );
  }
}

// ── Soul / Memory ──

/**
 * 读取账号的长期记忆内容。
 */
export async function querySoulContent(accountId: string): Promise<string> {
  const webUserId = getUserIdFromWebChatRuntimeId(accountId);
  if (webUserId) {
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
    'SELECT soul_content FROM accounts WHERE id = $1',
    [accountId],
  );
  if (rows.length === 0) return '';
  return (rows[0] as { soul_content: string }).soul_content || '';
}

/**
 * 更新账号的长期记忆内容。
 */
export async function updateSoulContentDb(
  accountId: string,
  content: string,
): Promise<void> {
  const webUserId = getUserIdFromWebChatRuntimeId(accountId);
  if (webUserId) {
    await getPool().query(
      `UPDATE accounts
       SET soul_content = $2
       WHERE id = (
         SELECT id
         FROM accounts
         WHERE owner_id = $1
         ORDER BY enabled DESC, created_at ASC
         LIMIT 1
       )`,
      [webUserId, content],
    );
    return;
  }

  await getPool().query(
    'UPDATE accounts SET soul_content = $2 WHERE id = $1',
    [accountId, content],
  );
}

// ── Tasks / Reminders ──

export interface TaskSnapshot {
  id: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  status: string;
  next_run: string | null;
}

/**
 * 查询账号的活跃定时任务列表。
 */
export async function queryTasksForAccount(
  accountId: string,
): Promise<TaskSnapshot[]> {
  const { rows } = await getPool().query(
    `SELECT id, prompt, schedule_type, schedule_value, status, next_run
     FROM scheduled_tasks
     WHERE account_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [accountId],
  );
  return rows as TaskSnapshot[];
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
    'tool_context IS NOT NULL',
  ];

  if (args.sessionId) {
    params.push(args.sessionId);
    conditions.push(`session_id = $${params.length}`);
  } else {
    conditions.push('session_id IS NULL');
  }

  const { rows } = await getPool().query(
    `SELECT tool_context
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

  for (const row of rows as Array<{ tool_context: string | null }>) {
    const toolContext = parseStoredToolContext(row.tool_context);
    if (toolContext.length === 0) continue;

    if (!context.interpretationOutput) {
      const interpretation = toolContext.find(
        (entry) => entry.skill === 'xuanxue-jiedu',
      );
      context.interpretationOutput = interpretation?.output ?? '';
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
