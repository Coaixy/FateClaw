/**
 * agent-runtime 直连数据库。
 * 替代原先通过 IPC 文件同步的方式，所有数据实时从 DB 查询。
 */

import { createHash } from 'node:crypto';
import pg from 'pg';

import { log } from './io.js';
import type { SkillContentRevision } from '@fateclaw/contracts/skills/content';

const { Pool } = pg;
const WEB_CHAT_RUNTIME_PREFIX = 'web:';

let pool: pg.Pool | null = null;
let concurrencyPolicy: { value: number; expiresAt: number } | null = null;

/** Live admin policy; an unavailable database must not silently raise execution capacity. */
export async function getAgentAccountConcurrency(): Promise<number> {
  if (concurrencyPolicy && concurrencyPolicy.expiresAt > Date.now())
    return concurrencyPolicy.value;
  const { rows } = await getAgentDbPool().query<{
    agent_account_concurrency: number;
  }>("SELECT agent_account_concurrency FROM runtime_config WHERE id='default'");
  const value = rows[0]?.agent_account_concurrency;
  if (!Number.isInteger(value) || value < 1 || value > 100)
    throw new Error(
      'Agent account concurrency configuration is missing or invalid',
    );
  concurrencyPolicy = { value, expiresAt: Date.now() + 2000 };
  return value;
}

export function getAgentDbPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('缺少 DATABASE_URL 环境变量');
    pool = new Pool({
      connectionString: url,
      max: 2,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
      query_timeout: 35_000,
      idle_in_transaction_session_timeout: 15_000,
    });
    pool.on('error', () => {
      // pg removes failed idle clients; subsequent operations acquire a new client.
      log('Database idle connection failed; client removed from pool');
    });
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
  concurrencyPolicy = null;
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ── Skills ──

export interface EffectiveUserSkill {
  id: string;
  dir: string;
  name: string;
  description: string;
  bundle_uri: string;
  checksum: string | null;
  revision_id: string | null;
  format_version: number | null;
  install_status: 'installed' | 'missing' | 'error';
  visibility: 'private' | 'link_shared' | 'shared';
  source: 'self' | 'subscribed';
  source_bundle_ids?: string[];
}

/**
 * 查询用户的有效自定义 Skill（自有 + 订阅且启用的）。
 *
 * @param userId 平台用户 ID。
 * @returns 当前用户在本轮请求中可见的自定义 Skill。
 */
export async function queryEffectiveUserSkills(
  userId: string,
): Promise<EffectiveUserSkill[]> {
  if (!userId) return [];
  const { rows } = await getAgentDbPool().query(
    `SELECT s.id, s.dir_name as dir, s.skill_name as name, s.description,
            s.bundle_uri, COALESCE(r.checksum, s.checksum) as checksum,
            r.id as revision_id, r.format_version,
            s.install_status, s.visibility,
            'self' as source,
            ARRAY(
              SELECT DISTINCT sbi.bundle_id
              FROM skill_bundle_items sbi
              JOIN skill_bundles b ON b.id = sbi.bundle_id
              WHERE sbi.skill_id = s.id
                AND b.user_id = $1
                AND b.deleted_at IS NULL
              ORDER BY sbi.bundle_id
            ) as source_bundle_ids
     FROM user_custom_skills s
     LEFT JOIN skill_content_revisions r ON r.skill_id = s.id AND r.id = s.current_revision_id
     WHERE s.user_id = $1 AND s.enabled = true AND s.deleted_at IS NULL AND s.install_status = 'installed'
     UNION ALL
    SELECT s.id, s.dir_name as dir, s.skill_name as name, s.description,
            s.bundle_uri, COALESCE(r.checksum, s.checksum) as checksum,
            r.id as revision_id, r.format_version,
            s.install_status, s.visibility,
            'subscribed' as source,
            ARRAY(
              SELECT DISTINCT src.bundle_id
              FROM user_skill_subscription_bundle_sources src
              JOIN skill_bundles b ON b.id = src.bundle_id
              WHERE src.subscription_id = sub.id
                AND b.deleted_at IS NULL
              ORDER BY src.bundle_id
            ) as source_bundle_ids
     FROM user_skill_subscriptions sub
     JOIN user_custom_skills s ON s.id = sub.skill_id
     LEFT JOIN skill_content_revisions r ON r.skill_id = s.id AND r.id = s.current_revision_id
     WHERE sub.subscriber_id = $1 AND sub.enabled = true AND sub.status = 'active'
       AND (sub.expires_at IS NULL OR sub.expires_at > NOW())
       AND s.deleted_at IS NULL
       AND (
         s.visibility IN ('link_shared', 'shared')
         OR sub.source_kind IN ('bundle_share', 'invite', 'bundle_invite')
       )
       AND s.install_status = 'installed'`,
    [userId],
  );
  return rows as EffectiveUserSkill[];
}

/** Read a selected immutable revision, including after another revision becomes current. */
export async function querySkillContentRevision(
  skillId: string,
  revisionId: string,
): Promise<SkillContentRevision | null> {
  const { rows } = await getAgentDbPool().query<SkillContentRevision>(
    `SELECT r.id AS "revisionId", r.skill_id AS "skillId", r.format_version AS "formatVersion",
            r.checksum, r.content_length AS "contentLength", r.files
     FROM skill_content_revisions r JOIN user_custom_skills s ON s.id = r.skill_id
     WHERE r.skill_id = $1 AND r.id = $2 AND s.deleted_at IS NULL`,
    [skillId, revisionId],
  );
  return rows[0] ?? null;
}

/**
 * 按单个 Skill id 查询用户的有效自定义 Skill（自有 + 订阅且启用的）。
 *
 * @param userId 平台用户 ID。
 * @param skillIds 请求级 Skill id 白名单。
 * @returns 交集结果——只返回用户实际拥有/订阅且启用的 Skill；无权或未启用的 id 自动丢弃。
 * @remarks 复用 queryEffectiveUserSkills 的归属/启用/安装/订阅有效期校验，
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

// ── Soul ──

/**
 * 读取账号可见的用户级 Soul。
 *
 * @param accountId 当前 agent-runtime 账号 ID；站内 AI Chat 使用 web:{userId}。
 * @returns 可注入 Pi Runtime 的 Soul 内容；未配置时返回空字符串。
 * @remarks 用户级 Soul 优先于账号级历史 Soul，确保 Dashboard 维护的是唯一长期记忆来源。
 */
export async function querySoulContent(accountId: string): Promise<string> {
  return readSoulContent(getAgentDbPool(), accountId);
}

async function readSoulContent(
  db: pg.Pool | pg.PoolClient,
  accountId: string,
  lock = false,
): Promise<string> {
  const webUserId = getUserIdFromWebChatRuntimeId(accountId);
  if (webUserId) {
    const userSoul = await db.query(
      `SELECT soul_content FROM users WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [webUserId],
    );
    const userContent =
      (userSoul.rows[0] as { soul_content: string } | undefined)
        ?.soul_content || '';
    if (userContent.trim()) return userContent;

    const { rows } = await db.query(
      `SELECT soul_content
       FROM accounts
       WHERE owner_id = $1
       ORDER BY enabled DESC, created_at ASC
       LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [webUserId],
    );
    if (rows.length === 0) return '';
    return (rows[0] as { soul_content: string }).soul_content || '';
  }

  if (lock) {
    await db.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [
      accountId,
    ]);
    await db.query(
      'SELECT id FROM users WHERE id = (SELECT owner_id FROM accounts WHERE id = $1) FOR UPDATE',
      [accountId],
    );
  }
  const { rows } = await db.query(
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
    const { rows } = await getAgentDbPool().query(
      'SELECT soul_edit_enabled FROM users WHERE id = $1',
      [webUserId],
    );
    return (
      (rows[0] as { soul_edit_enabled: boolean | null } | undefined)
        ?.soul_edit_enabled ?? true
    );
  }

  const { rows } = await getAgentDbPool().query(
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
 * Compare the effective Soul and replace its canonical source in one transaction.
 * Locks include legacy fallback rows because they contribute to the baseHash.
 * Serialization or deadlock conflicts require a fresh read, never a blind retry.
 */
export async function updateSoulContentDb(
  accountId: string,
  content: string,
  expectedHash: string,
): Promise<boolean> {
  const client = await getAgentDbPool().connect();
  let discardClient = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const current = await readSoulContent(client, accountId, true);
    if (
      createHash('sha256').update(current, 'utf8').digest('hex') !==
      expectedHash
    ) {
      await client.query('ROLLBACK');
      return false;
    }
    const webUserId = getUserIdFromWebChatRuntimeId(accountId);
    let updated: pg.QueryResult;
    if (webUserId) {
      updated = await client.query(
        'UPDATE users SET soul_content = $2 WHERE id = $1',
        [webUserId, content],
      );
    } else {
      updated = await client.query(
        `UPDATE users SET soul_content = $2
         WHERE id = (SELECT owner_id FROM accounts WHERE id = $1 AND owner_id IS NOT NULL)`,
        [accountId, content],
      );
      if ((updated.rowCount ?? 0) === 0) {
        updated = await client.query(
          'UPDATE accounts SET soul_content = $2 WHERE id = $1',
          [accountId, content],
        );
      }
    }
    await client.query('COMMIT');
    return (updated.rowCount ?? 0) > 0;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discardClient = true;
    }
    const code = (error as { code?: string }).code;
    if (code === '40001' || code === '40P01') return false;
    throw error;
  } finally {
    client.release(discardClient);
  }
}
