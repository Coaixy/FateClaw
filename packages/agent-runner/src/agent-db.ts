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
}

/**
 * 查询用户的有效自定义 Skill（自有 + 订阅且启用的）。
 */
export async function queryEffectiveUserSkills(
  userId: string,
): Promise<EffectiveUserSkill[]> {
  if (!userId) return [];
  const { rows } = await getPool().query(
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
       AND s.deleted_at IS NULL AND s.visibility IN ('link_shared', 'shared') AND s.install_status = 'installed'`,
    [userId],
  );
  return rows as EffectiveUserSkill[];
}

// ── Soul / Memory ──

/**
 * 读取账号的长期记忆内容。
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
 * 更新账号的长期记忆内容。
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
