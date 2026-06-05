import { readTextSkillBundleFiles } from '../../modules/skills/text-skill-bundle-store.js';
import { getDbPool } from '../db-pool.js';

const pool = {
  query(sql: string, params?: unknown[]) {
    return getDbPool().query(sql, params);
  },
};

export interface AdminGlobalStats {
  total_users: number;
  plan_distribution: { plan: string; count: number }[];
  model_selection_distribution: { source: string; count: number }[];
  active_subscriptions: number;
  total_recharge_orders: number;
  paid_recharge_orders: number;
  pending_recharge_orders: number;
  total_recharge_coins: number;
  today_recharge_coins: number;
  total_accounts: number;
  enabled_accounts: number;
  total_messages: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  today_messages: number;
  today_input_tokens: number;
  today_output_tokens: number;
  today_total_tokens: number;
  recent_signups_7d: number;
  recharge_period: AdminRechargePeriodStats;
}

export type AdminRechargeStatsRange =
  | 'today'
  | '7d'
  | '30d'
  | 'month'
  | 'custom'
  | 'all';

export interface AdminRechargePeriodStats {
  range: AdminRechargeStatsRange;
  label: string;
  start_date: string | null;
  end_date: string | null;
  paid_orders: number;
  total_recharge_coins: number;
}

export interface AdminMessageRow {
  id: string;
  account_id: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message: boolean;
  session_id: string | null;
  session_title: string | null;
  deleted_at: string | null;
  session_deleted_at: string | null;
}

export async function getMessagesForAdmin(opts: {
  accountId?: string;
  userId?: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ messages: AdminMessageRow[]; total: number }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  let whereClause = 'WHERE 1=1';
  const params: unknown[] = [];
  let paramIdx = 1;

  if (opts.accountId) {
    whereClause += ` AND m.account_id = $${paramIdx++}`;
    params.push(opts.accountId);
  } else if (opts.userId) {
    whereClause += ` AND (
      m.user_id = $${paramIdx}
      OR m.account_id IN (SELECT id FROM accounts WHERE owner_id = $${paramIdx})
      OR EXISTS (
        SELECT 1 FROM chat_sessions s
        WHERE s.id = m.session_id AND s.user_id = $${paramIdx}
      )
    )`;
    params.push(opts.userId);
    paramIdx++;
  }
  if (opts.sessionId) {
    whereClause += ` AND m.session_id = $${paramIdx++}`;
    params.push(opts.sessionId);
  }

  const countQuery = `SELECT COUNT(*) as cnt FROM messages m ${whereClause}`;
  const { rows: countRows } = await pool.query(countQuery, params);
  const total = Number((countRows[0] as { cnt: string }).cnt);

  const dataQuery = `SELECT m.id, m.account_id, m.sender, m.sender_name, m.content, m.timestamp, m.is_from_me, m.is_bot_message,
      m.session_id, s.title AS session_title, m.deleted_at, s.deleted_at AS session_deleted_at
    FROM messages m
    LEFT JOIN chat_sessions s ON s.id = m.session_id
    ${whereClause}
    ORDER BY (m.deleted_at IS NOT NULL) ASC, m.timestamp DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
  const { rows } = await pool.query(dataQuery, [...params, limit, offset]);

  return { messages: rows as AdminMessageRow[], total };
}

export interface AdminChatSessionRow {
  id: string;
  account_id: string;
  account_name: string;
  owner_user_id: string | null;
  owner_phone: string | null;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message_at: string | null;
  last_message_preview: string | null;
  deleted_at: string | null;
  pi_session_archived_at: string | null;
  pi_session_archive_reason: string | null;
}

export async function getChatSessionsForAdmin(opts: {
  accountId?: string;
  userId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ sessions: AdminChatSessionRow[]; total: number }> {
  const limit = Math.min(opts.limit ?? 100, 200);
  const offset = opts.offset ?? 0;

  let whereClause = 'WHERE 1=1';
  const params: unknown[] = [];
  let paramIdx = 1;

  if (opts.accountId) {
    whereClause += ` AND s.account_id = $${paramIdx++}`;
    params.push(opts.accountId);
  } else if (opts.userId) {
    whereClause += ` AND COALESCE(s.user_id, a.owner_id) = $${paramIdx++}`;
    params.push(opts.userId);
  }

  const countQuery = `SELECT COUNT(*) AS cnt
    FROM chat_sessions s
    LEFT JOIN accounts a ON a.id = s.account_id
    ${whereClause}`;
  const { rows: countRows } = await pool.query(countQuery, params);
  const total = Number((countRows[0] as { cnt: string }).cnt);

  const dataQuery = `SELECT s.id,
      s.account_id,
      COALESCE(a.name, CASE WHEN s.account_id LIKE 'web:%' THEN '站内 AI Chat' ELSE s.account_id END) AS account_name,
      COALESCE(s.user_id, a.owner_id) AS owner_user_id,
      u.phone AS owner_phone,
      s.title,
      s.created_at,
      s.updated_at,
      s.deleted_at,
      s.pi_session_archived_at,
      s.pi_session_archive_reason,
      COALESCE(mc.message_count, 0)::int AS message_count,
      lm.last_message_at,
      lm.last_message_preview
    FROM chat_sessions s
    LEFT JOIN accounts a ON a.id = s.account_id
    LEFT JOIN users u ON u.id = COALESCE(s.user_id, a.owner_id)
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS message_count
      FROM messages m
      WHERE m.session_id = s.id
    ) mc ON true
    LEFT JOIN LATERAL (
      SELECT m.timestamp AS last_message_at,
        LEFT(m.content, 160) AS last_message_preview
      FROM messages m
      WHERE m.session_id = s.id
      ORDER BY m.timestamp DESC
      LIMIT 1
    ) lm ON true
    ${whereClause}
    ORDER BY (s.deleted_at IS NOT NULL) ASC, COALESCE(lm.last_message_at, s.updated_at) DESC
    LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
  const { rows } = await pool.query(dataQuery, [...params, limit, offset]);

  return { sessions: rows as AdminChatSessionRow[], total };
}

/** 管理后台清理 Pi session 文件时使用的会话候选行。 */
export interface AdminChatSessionPiCleanupCandidate {
  id: string;
  account_id: string;
  updated_at: string;
  deleted_at: string | null;
  pi_session_archived_at: string | null;
}

export interface AdminChatSessionPiArchiveState {
  id: string;
  pi_session_archived_at: string | null;
  has_pi_session_archive_payload: boolean;
}

/**
 * 查询需要清理 Pi session 文件的网页会话。
 *
 * @param opts - 清理条件；softDeleted 为 true 时包含软删除会话，inactiveBefore 为未活跃截止时间。
 * @returns 最多 limit 条候选会话。
 */
export async function getChatSessionPiCleanupCandidates(opts: {
  softDeleted?: boolean;
  inactiveBefore?: string;
  limit?: number;
  cursor?: string;
}): Promise<AdminChatSessionPiCleanupCandidate[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (opts.softDeleted) {
    conditions.push('deleted_at IS NOT NULL');
  }

  if (opts.inactiveBefore) {
    conditions.push(`(deleted_at IS NULL AND updated_at < $${paramIdx++})`);
    params.push(opts.inactiveBefore);
  }

  if (conditions.length === 0) {
    return [];
  }

  const eligibilityClause = conditions
    .map((condition) => `(${condition})`)
    .join(' OR ');
  const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 5000);
  if (opts.cursor) {
    params.push(opts.cursor);
    conditions.push(`s.id > $${paramIdx++}`);
  }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT id, account_id, updated_at, deleted_at, pi_session_archived_at
     FROM chat_sessions s
     WHERE (${eligibilityClause})
       ${opts.cursor ? `AND ${conditions.at(-1)}` : ''}
       AND (
         pi_session_archived_at IS NULL
         OR pi_session_archive_payload IS NOT NULL
       )
       AND NOT EXISTS (
         SELECT 1
         FROM user_memberships m
         WHERE m.user_id = s.user_id
           AND m.status = 'active'
           AND m.current_period_end > NOW()
       )
     ORDER BY id ASC
     LIMIT $${paramIdx}`,
    params,
  );

  return rows as AdminChatSessionPiCleanupCandidate[];
}

/**
 * 批量读取 chat session 的 Pi session 归档状态。
 *
 * @param sessionIds - 从文件名中保守解析出的 chat session id。
 * @returns 已存在 session 的归档状态；不存在的 id 不返回。
 */
export async function getChatSessionPiArchiveStates(
  sessionIds: string[],
): Promise<AdminChatSessionPiArchiveState[]> {
  const ids = [...new Set(sessionIds.filter((id) => id.trim()))];
  if (ids.length === 0) {
    return [];
  }

  const { rows } = await pool.query(
    `SELECT id,
            pi_session_archived_at,
            pi_session_archive_payload IS NOT NULL AS has_pi_session_archive_payload
     FROM chat_sessions
     WHERE id = ANY($1::text[])`,
    [ids],
  );
  return rows as AdminChatSessionPiArchiveState[];
}

/** 管理后台增量清理 Pi session 时保存的扫描水位。 */
export interface AdminPiSessionCleanupCursorRow {
  mode: 'soft_deleted' | 'inactive';
  cursor_session_id: string | null;
  scanned_sessions: number;
  updated_at: string;
}

/**
 * 读取 Pi session 清理扫描水位。
 *
 * @param mode - 清理模式。
 * @returns 当前水位；首次运行时返回 undefined。
 */
export async function getPiSessionCleanupCursor(
  mode: 'soft_deleted' | 'inactive',
): Promise<AdminPiSessionCleanupCursorRow | undefined> {
  const { rows } = await pool.query(
    `SELECT mode, cursor_session_id, scanned_sessions, updated_at
     FROM pi_session_cleanup_cursors
     WHERE mode = $1`,
    [mode],
  );
  return rows[0] as AdminPiSessionCleanupCursorRow | undefined;
}

/**
 * 更新 Pi session 清理扫描水位。
 *
 * @param input.mode - 清理模式。
 * @param input.cursorSessionId - 本批扫描的最后一个 session id。
 * @param input.scannedSessions - 本批扫描数量。
 */
export async function upsertPiSessionCleanupCursor(input: {
  mode: 'soft_deleted' | 'inactive';
  cursorSessionId: string;
  scannedSessions: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO pi_session_cleanup_cursors (
       mode, cursor_session_id, scanned_sessions, updated_at
     )
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (mode) DO UPDATE SET
       cursor_session_id = EXCLUDED.cursor_session_id,
       scanned_sessions =
         pi_session_cleanup_cursors.scanned_sessions + EXCLUDED.scanned_sessions,
       updated_at = NOW()`,
    [input.mode, input.cursorSessionId, input.scannedSessions],
  );
}

/**
 * 重置 Pi session 清理扫描水位。
 *
 * @param mode - 清理模式。
 */
export async function resetPiSessionCleanupCursor(
  mode: 'soft_deleted' | 'inactive',
): Promise<void> {
  await pool.query(
    `INSERT INTO pi_session_cleanup_cursors (
       mode, cursor_session_id, scanned_sessions, updated_at
     )
     VALUES ($1, NULL, 0, NOW())
     ON CONFLICT (mode) DO UPDATE SET
       cursor_session_id = NULL,
       scanned_sessions = 0,
       updated_at = NOW()`,
    [mode],
  );
}

export interface AdminCustomSkillRow {
  id: string;
  user_id: string;
  phone: string;
  skill_name: string;
  description: string;
  bundle_uri: string;
  checksum: string | null;
  install_status: 'installed' | 'missing' | 'error';
  files: Array<{ path: string; content: string }>;
  content_length: number;
  visibility: 'private' | 'link_shared' | 'shared';
  share_token: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

function hydrateAdminCustomSkillRow(
  row: AdminCustomSkillRow,
): AdminCustomSkillRow {
  const files = readTextSkillBundleFiles(row.bundle_uri);
  return {
    ...row,
    files,
    content_length: files.reduce((sum, file) => sum + file.content.length, 0),
  };
}

export async function getCustomSkillsForAdmin(opts: {
  userId?: string;
}): Promise<AdminCustomSkillRow[]> {
  let whereClause = 'WHERE s.deleted_at IS NULL';
  const params: unknown[] = [];
  let paramIdx = 1;

  if (opts.userId) {
    whereClause += ` AND s.user_id = $${paramIdx++}`;
    params.push(opts.userId);
  }

  const { rows } = await pool.query(
    `SELECT s.id, s.user_id, u.phone, s.skill_name, s.description,
            s.bundle_uri, s.checksum, s.install_status,
            s.visibility, s.share_token, s.enabled,
            s.created_at, s.updated_at
     FROM user_custom_skills s
     JOIN users u ON u.id = s.user_id
     ${whereClause}
     ORDER BY s.created_at DESC`,
    params,
  );

  return (rows as AdminCustomSkillRow[]).map(hydrateAdminCustomSkillRow);
}

export async function getCustomSkillForAdmin(
  id: string,
): Promise<AdminCustomSkillRow | undefined> {
  const { rows } = await pool.query(
    `SELECT s.id, s.user_id, u.phone, s.skill_name, s.description,
            s.bundle_uri, s.checksum, s.install_status,
            s.visibility, s.share_token, s.enabled,
            s.created_at, s.updated_at
     FROM user_custom_skills s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [id],
  );
  return rows[0]
    ? hydrateAdminCustomSkillRow(rows[0] as AdminCustomSkillRow)
    : undefined;
}

function dateOnlyFromOffset(baseDate: Date, offsetDays: number): string {
  const date = new Date(
    Date.UTC(
      baseDate.getUTCFullYear(),
      baseDate.getUTCMonth(),
      baseDate.getUTCDate() + offsetDays,
    ),
  );
  return date.toISOString().slice(0, 10);
}

function firstDateOfCurrentMonth(baseDate: Date): string {
  return new Date(
    Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), 1),
  )
    .toISOString()
    .slice(0, 10);
}

function resolveAdminRechargePeriod(opts: {
  range?: AdminRechargeStatsRange;
  startDate?: string;
  endDate?: string;
}): {
  range: AdminRechargeStatsRange;
  label: string;
  startDate: string | null;
  endDate: string | null;
  endExclusiveDate: string | null;
} {
  const now = new Date();
  const today = dateOnlyFromOffset(now, 0);

  if (opts.startDate && opts.endDate) {
    return {
      range: 'custom',
      label: `${opts.startDate} 至 ${opts.endDate}`,
      startDate: opts.startDate,
      endDate: opts.endDate,
      endExclusiveDate: dateOnlyFromOffset(
        new Date(`${opts.endDate}T00:00:00.000Z`),
        1,
      ),
    };
  }

  const selectedRange = opts.range ?? 'all';

  if (selectedRange === 'today') {
    return {
      range: selectedRange,
      label: '今日',
      startDate: today,
      endDate: today,
      endExclusiveDate: dateOnlyFromOffset(now, 1),
    };
  }

  if (selectedRange === '7d') {
    const startDate = dateOnlyFromOffset(now, -6);
    return {
      range: selectedRange,
      label: '近 7 天',
      startDate,
      endDate: today,
      endExclusiveDate: dateOnlyFromOffset(now, 1),
    };
  }

  if (selectedRange === '30d') {
    const startDate = dateOnlyFromOffset(now, -29);
    return {
      range: selectedRange,
      label: '近 30 天',
      startDate,
      endDate: today,
      endExclusiveDate: dateOnlyFromOffset(now, 1),
    };
  }

  if (selectedRange === 'month') {
    return {
      range: selectedRange,
      label: '本月',
      startDate: firstDateOfCurrentMonth(now),
      endDate: today,
      endExclusiveDate: dateOnlyFromOffset(now, 1),
    };
  }

  return {
    range: 'all',
    label: '累计',
    startDate: null,
    endDate: null,
    endExclusiveDate: null,
  };
}

export async function getAdminGlobalStats(
  opts: {
    rechargeRange?: AdminRechargeStatsRange;
    rechargeStartDate?: string;
    rechargeEndDate?: string;
  } = {},
): Promise<AdminGlobalStats> {
  const today = new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const rechargePeriod = resolveAdminRechargePeriod({
    range: opts.rechargeRange,
    startDate: opts.rechargeStartDate,
    endDate: opts.rechargeEndDate,
  });
  const rechargeStatsParams = [
    today,
    rechargePeriod.startDate,
    rechargePeriod.endExclusiveDate,
  ];

  const [
    userCount,
    modelSelectionDist,
    accountStats,
    totalUsage,
    todayUsage,
    recentSignups,
    rechargeStats,
  ] = await Promise.all([
    pool.query('SELECT COUNT(*) as cnt FROM users'),
    pool.query(
      `SELECT COALESCE(sel.source, 'unselected') as model_source, COUNT(*) as count
       FROM users u
       LEFT JOIN user_model_selections sel ON sel.user_id = u.id
       GROUP BY COALESCE(sel.source, 'unselected')
       ORDER BY count DESC`,
    ),
    pool.query(
      `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE enabled = true) as enabled
       FROM accounts`,
    ),
    pool.query(
      `SELECT COALESCE(SUM(msg_count), 0) as msgs, COALESCE(SUM(input_tokens), 0) as inp, COALESCE(SUM(output_tokens), 0) as outp, COALESCE(SUM(total_tokens), 0) as total FROM daily_usage`,
    ),
    pool.query(
      `SELECT COALESCE(SUM(msg_count), 0) as msgs, COALESCE(SUM(input_tokens), 0) as inp, COALESCE(SUM(output_tokens), 0) as outp, COALESCE(SUM(total_tokens), 0) as total FROM daily_usage WHERE date = $1`,
      [today],
    ),
    pool.query(`SELECT COUNT(*) as cnt FROM users WHERE created_at >= $1`, [
      sevenDaysAgo,
    ]),
    pool.query(
      `SELECT
         COUNT(*)::int AS total_orders,
         COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_orders,
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_orders,
         COALESCE(SUM(amount_coins) FILTER (WHERE status = 'paid'), 0)::float8
           AS total_coins,
         COALESCE(SUM(amount_coins) FILTER (
           WHERE status = 'paid'
             AND paid_at >= $1::date
             AND paid_at < ($1::date + INTERVAL '1 day')
         ), 0)::float8 AS today_coins,
         COUNT(*) FILTER (
           WHERE status = 'paid'
             AND ($2::date IS NULL OR paid_at >= $2::date)
             AND ($3::date IS NULL OR paid_at < $3::date)
         )::int AS period_paid_orders,
         COALESCE(SUM(amount_coins) FILTER (
           WHERE status = 'paid'
             AND ($2::date IS NULL OR paid_at >= $2::date)
             AND ($3::date IS NULL OR paid_at < $3::date)
         ), 0)::float8 AS period_coins
       FROM recharge_orders`,
      rechargeStatsParams,
    ),
  ]);

  const acc = accountStats.rows[0] as { total: string; enabled: string };
  const tu = totalUsage.rows[0] as {
    msgs: string;
    inp: string;
    outp: string;
    total: string;
  };
  const td = todayUsage.rows[0] as {
    msgs: string;
    inp: string;
    outp: string;
    total: string;
  };
  const rs = rechargeStats.rows[0] as {
    total_orders: number;
    paid_orders: number;
    pending_orders: number;
    total_coins: number;
    today_coins: number;
    period_paid_orders: number;
    period_coins: number;
  };

  const modelSelectionDistribution = (
    modelSelectionDist.rows as { model_source: string; count: string }[]
  ).map((r) => ({
    source: r.model_source,
    count: Number(r.count),
  }));

  return {
    total_users: Number((userCount.rows[0] as { cnt: string }).cnt),
    model_selection_distribution: modelSelectionDistribution,
    plan_distribution: modelSelectionDistribution.map((r) => ({
      plan: r.source,
      count: r.count,
    })),
    active_subscriptions: 0,
    total_recharge_orders: Number(rs.total_orders),
    paid_recharge_orders: Number(rs.paid_orders),
    pending_recharge_orders: Number(rs.pending_orders),
    total_recharge_coins: Number(rs.total_coins),
    today_recharge_coins: Number(rs.today_coins),
    recharge_period: {
      range: rechargePeriod.range,
      label: rechargePeriod.label,
      start_date: rechargePeriod.startDate,
      end_date: rechargePeriod.endDate,
      paid_orders: Number(rs.period_paid_orders),
      total_recharge_coins: Number(rs.period_coins),
    },
    total_accounts: Number(acc.total),
    enabled_accounts: Number(acc.enabled),
    total_messages: Number(tu.msgs),
    total_input_tokens: Number(tu.inp),
    total_output_tokens: Number(tu.outp),
    total_tokens: Number(tu.total),
    today_messages: Number(td.msgs),
    today_input_tokens: Number(td.inp),
    today_output_tokens: Number(td.outp),
    today_total_tokens: Number(td.total),
    recent_signups_7d: Number((recentSignups.rows[0] as { cnt: string }).cnt),
  };
}
