import { readTextSkillBundleContent } from '../../modules/skills/text-skill-bundle-store.js';
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
  total_recharge_points: number;
  total_recharge_yuan: string;
  today_recharge_points: number;
  today_recharge_yuan: string;
  total_accounts: number;
  enabled_accounts: number;
  total_messages: number;
  total_input_tokens: number;
  total_output_tokens: number;
  today_messages: number;
  today_input_tokens: number;
  today_output_tokens: number;
  active_tasks: number;
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
  total_recharge_points: number;
  total_recharge_yuan: string;
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

export interface AdminTaskRow {
  id: string;
  account_id: string;
  account_name: string;
  owner_phone: string | null;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  reminder_type: string | null;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: string;
  created_at: string;
}

export async function getTasksForAdmin(opts: {
  userId?: string;
  status?: string;
  limit?: number;
}): Promise<AdminTaskRow[]> {
  let whereClause = 'WHERE t.deleted_at IS NULL';
  const params: unknown[] = [];
  let paramIdx = 1;

  if (opts.userId) {
    whereClause += ` AND a.owner_id = $${paramIdx++}`;
    params.push(opts.userId);
  }
  if (opts.status) {
    whereClause += ` AND t.status = $${paramIdx++}`;
    params.push(opts.status);
  }
  // 上限默认 500，admin 视角通常按 user/status 过滤
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT t.id, t.account_id, a.name as account_name, u.phone as owner_phone,
            t.prompt, t.schedule_type, t.schedule_value, t.reminder_type,
            t.next_run, t.last_run, t.last_result, t.status, t.created_at
     FROM scheduled_tasks t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN users u ON u.id = a.owner_id
     ${whereClause}
     ORDER BY t.created_at DESC
     LIMIT $${paramIdx}`,
    params,
  );

  return rows as AdminTaskRow[];
}

export interface AdminSkillRow {
  user_id: string;
  phone: string;
  skill_name: string;
  enabled: boolean;
  enabled_at: string;
}

export async function getSkillsForAdmin(opts: {
  userId?: string;
}): Promise<AdminSkillRow[]> {
  let whereClause = 'WHERE s.deleted_at IS NULL';
  const params: unknown[] = [];
  let paramIdx = 1;

  if (opts.userId) {
    whereClause += ` AND s.user_id = $${paramIdx++}`;
    params.push(opts.userId);
  }

  const { rows } = await pool.query(
    `SELECT s.user_id, u.phone, s.skill_name, s.enabled, s.enabled_at
     FROM user_skills s
     JOIN users u ON u.id = s.user_id
     ${whereClause}
     ORDER BY s.enabled_at DESC`,
    params,
  );

  return rows as AdminSkillRow[];
}

export interface AdminCustomSkillRow {
  id: string;
  user_id: string;
  phone: string;
  skill_name: string;
  description: string;
  trigger_hint: string;
  content: string;
  bundle_uri: string;
  checksum: string | null;
  install_status: 'installed' | 'missing' | 'error';
  category: string;
  match_keywords: string[];
  usage_mode: 'force_injected' | 'reference_only';
  visibility: 'private' | 'link_shared' | 'shared';
  share_token: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
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
            s.trigger_hint, s.bundle_uri, s.checksum, s.install_status, s.category, s.match_keywords,
            s.usage_mode, s.visibility, s.share_token, s.enabled,
            s.created_at, s.updated_at
     FROM user_custom_skills s
     JOIN users u ON u.id = s.user_id
     ${whereClause}
     ORDER BY s.created_at DESC`,
    params,
  );

  return (rows as AdminCustomSkillRow[]).map((row) => ({
    ...row,
    content: readTextSkillBundleContent(row.bundle_uri),
  }));
}

export async function getCustomSkillForAdmin(
  id: string,
): Promise<AdminCustomSkillRow | undefined> {
  const { rows } = await pool.query(
    `SELECT s.id, s.user_id, u.phone, s.skill_name, s.description,
            s.trigger_hint, s.bundle_uri, s.checksum, s.install_status, s.category, s.match_keywords,
            s.usage_mode, s.visibility, s.share_token, s.enabled,
            s.created_at, s.updated_at
     FROM user_custom_skills s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [id],
  );
  return rows[0]
    ? {
        ...(rows[0] as AdminCustomSkillRow),
        content: readTextSkillBundleContent(
          (rows[0] as AdminCustomSkillRow).bundle_uri,
        ),
      }
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
    taskCount,
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
      `SELECT COALESCE(SUM(msg_count), 0) as msgs, COALESCE(SUM(input_tokens), 0) as inp, COALESCE(SUM(output_tokens), 0) as outp FROM daily_usage`,
    ),
    pool.query(
      `SELECT COALESCE(SUM(msg_count), 0) as msgs, COALESCE(SUM(input_tokens), 0) as inp, COALESCE(SUM(output_tokens), 0) as outp FROM daily_usage WHERE date = $1`,
      [today],
    ),
    pool.query(
      `SELECT COUNT(*) as cnt FROM scheduled_tasks WHERE status = 'active' AND deleted_at IS NULL`,
    ),
    pool.query(`SELECT COUNT(*) as cnt FROM users WHERE created_at >= $1`, [
      sevenDaysAgo,
    ]),
    pool.query(
      `SELECT
         COUNT(*)::int AS total_orders,
         COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_orders,
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_orders,
         COALESCE(SUM(amount_points) FILTER (WHERE status = 'paid'), 0)::int
           AS total_points,
         COALESCE(SUM(amount_yuan) FILTER (WHERE status = 'paid'), 0)::text
           AS total_yuan,
         COALESCE(SUM(amount_points) FILTER (
           WHERE status = 'paid' AND paid_at >= $1::date
         ), 0)::int AS today_points,
         COALESCE(SUM(amount_yuan) FILTER (
           WHERE status = 'paid'
             AND paid_at >= $1::date
             AND paid_at < ($1::date + INTERVAL '1 day')
         ), 0)::text AS today_yuan,
         COUNT(*) FILTER (
           WHERE status = 'paid'
             AND ($2::date IS NULL OR paid_at >= $2::date)
             AND ($3::date IS NULL OR paid_at < $3::date)
         )::int AS period_paid_orders,
         COALESCE(SUM(amount_points) FILTER (
           WHERE status = 'paid'
             AND ($2::date IS NULL OR paid_at >= $2::date)
             AND ($3::date IS NULL OR paid_at < $3::date)
         ), 0)::int AS period_points,
         COALESCE(SUM(amount_yuan) FILTER (
           WHERE status = 'paid'
             AND ($2::date IS NULL OR paid_at >= $2::date)
             AND ($3::date IS NULL OR paid_at < $3::date)
         ), 0)::text AS period_yuan
       FROM recharge_orders`,
      rechargeStatsParams,
    ),
  ]);

  const acc = accountStats.rows[0] as { total: string; enabled: string };
  const tu = totalUsage.rows[0] as { msgs: string; inp: string; outp: string };
  const td = todayUsage.rows[0] as { msgs: string; inp: string; outp: string };
  const rs = rechargeStats.rows[0] as {
    total_orders: number;
    paid_orders: number;
    pending_orders: number;
    total_points: number;
    total_yuan: string;
    today_points: number;
    today_yuan: string;
    period_paid_orders: number;
    period_points: number;
    period_yuan: string;
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
    total_recharge_points: Number(rs.total_points),
    total_recharge_yuan: rs.total_yuan,
    today_recharge_points: Number(rs.today_points),
    today_recharge_yuan: rs.today_yuan,
    recharge_period: {
      range: rechargePeriod.range,
      label: rechargePeriod.label,
      start_date: rechargePeriod.startDate,
      end_date: rechargePeriod.endDate,
      paid_orders: Number(rs.period_paid_orders),
      total_recharge_points: Number(rs.period_points),
      total_recharge_yuan: rs.period_yuan,
    },
    total_accounts: Number(acc.total),
    enabled_accounts: Number(acc.enabled),
    total_messages: Number(tu.msgs),
    total_input_tokens: Number(tu.inp),
    total_output_tokens: Number(tu.outp),
    today_messages: Number(td.msgs),
    today_input_tokens: Number(td.inp),
    today_output_tokens: Number(td.outp),
    active_tasks: Number((taskCount.rows[0] as { cnt: string }).cnt),
    recent_signups_7d: Number((recentSignups.rows[0] as { cnt: string }).cnt),
  };
}
