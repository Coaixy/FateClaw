import type { DbQueryable } from './db-pool.js';
import { getDbPool } from './db.js';
import { getRedis } from './redis.js';

export interface DailyUsageRow {
  date: string;
  msg_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  official_model_charge_coins: number;
}

export interface UsageStats {
  total_messages: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  monthly_messages: number;
  today_messages: number;
  today_input_tokens: number;
  today_output_tokens: number;
  today_total_tokens: number;
}

/** 管理后台完整状态页统计，不对公开接口暴露。 */
export interface AdminStatusStats {
  today_messages: number;
  registered_users: number;
  today_total_tokens: number;
  processing_sessions: number;
  token_usage_series: PublicStatusTokenUsagePoint[];
}

export interface PublicStatusTokenUsagePoint {
  date: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

const PROCESSING_SESSION_KEY_PATTERN = 'session:processing:*';
const PUBLIC_STATUS_TOKEN_USAGE_DAYS = 7;

function resolveMonthRange(yearMonth: string): { start: string; end: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!match) {
    throw new Error('月份格式必须为 YYYY-MM');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || month < 1 || month > 12) {
    throw new Error('月份格式必须为 YYYY-MM');
  }
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function recentUtcDateKeys(days: number): string[] {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - (days - index - 1));
    return date.toISOString().slice(0, 10);
  });
}

async function countProcessingSessions(): Promise<number> {
  const redis = getRedis();
  let cursor = '0';
  let total = 0;

  do {
    // 状态页只需要数量，使用 SCAN 分批遍历，避免 KEYS 阻塞 Redis。
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      PROCESSING_SESSION_KEY_PATTERN,
      'COUNT',
      100,
    );
    cursor = nextCursor;
    total += keys.length;
  } while (cursor !== '0');

  return total;
}

async function getPublicStatusTokenUsageSeries(
  days = PUBLIC_STATUS_TOKEN_USAGE_DAYS,
): Promise<PublicStatusTokenUsagePoint[]> {
  const dates = recentUtcDateKeys(days);
  const { rows } = await getDbPool().query(
    `SELECT date,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens
     FROM daily_usage
     WHERE date = ANY($1::text[])
     GROUP BY date`,
    [dates],
  );
  const byDate = new Map(
    rows.map((row) => {
      const item = row as {
        date: string;
        input_tokens: string | number;
        output_tokens: string | number;
        total_tokens: string | number;
      };
      return [
        item.date,
        {
          input_tokens: Number(item.input_tokens),
          output_tokens: Number(item.output_tokens),
          total_tokens: Number(item.total_tokens),
        },
      ];
    }),
  );

  return dates.map((date) => {
    const usage = byDate.get(date) ?? {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    };
    return {
      date,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens,
    };
  });
}

export async function incrementDailyMessageCount(
  userId: string,
  date: string,
  db: DbQueryable = getDbPool(),
): Promise<void> {
  await db.query(
    `INSERT INTO daily_usage (user_id, date, msg_count)
     VALUES ($1, $2, 1)
     ON CONFLICT (user_id, date) DO UPDATE SET msg_count = daily_usage.msg_count + 1`,
    [userId, date],
  );
}

export async function incrementDailyTokens(
  userId: string,
  date: string,
  inputTokens: number,
  outputTokens: number,
  totalTokens = inputTokens + outputTokens,
  db: DbQueryable = getDbPool(),
): Promise<void> {
  await db.query(
    `INSERT INTO daily_usage (user_id, date, msg_count, input_tokens, output_tokens, total_tokens)
     VALUES ($1, $2, 0, $3, $4, $5)
     ON CONFLICT (user_id, date) DO UPDATE SET
       input_tokens = daily_usage.input_tokens + $3,
       output_tokens = daily_usage.output_tokens + $4,
       total_tokens = daily_usage.total_tokens + $5`,
    [userId, date, inputTokens, outputTokens, totalTokens],
  );
}

export async function getMonthlyTokenUsage(
  userId: string,
  yearMonth?: string,
): Promise<number> {
  const ym = yearMonth ?? new Date().toISOString().slice(0, 7);
  const range = resolveMonthRange(ym);
  const { rows } = await getDbPool().query(
    `SELECT COALESCE(SUM(total_tokens), 0) AS total
     FROM daily_usage
     WHERE user_id = $1
       AND date >= $2
       AND date < $3`,
    [userId, range.start, range.end],
  );
  return Number((rows[0] as { total: string | number }).total);
}

/**
 * 批量读取用户当月 token 用量。
 *
 * @param userIds 需要统计的用户 ID 列表。
 * @param yearMonth 月份，格式为 YYYY-MM；不传时使用当前 UTC 月份。
 * @returns userId 到当月 token 总量的映射；无记录的用户返回 0。
 */
export async function getMonthlyTokenUsageByUserIds(
  userIds: string[],
  yearMonth?: string,
): Promise<Map<string, number>> {
  const result = new Map(userIds.map((userId) => [userId, 0]));
  if (userIds.length === 0) return result;
  const ym = yearMonth ?? new Date().toISOString().slice(0, 7);
  const range = resolveMonthRange(ym);
  const { rows } = await getDbPool().query(
    `SELECT user_id, COALESCE(SUM(total_tokens), 0) AS total
     FROM daily_usage
     WHERE user_id = ANY($1::text[])
       AND date >= $2
       AND date < $3
     GROUP BY user_id`,
    [userIds, range.start, range.end],
  );
  for (const row of rows as Array<{
    user_id: string;
    total: string | number;
  }>) {
    result.set(row.user_id, Number(row.total));
  }
  return result;
}

export async function getUsageStats(userId: string): Promise<UsageStats> {
  const today = new Date().toISOString().slice(0, 10);
  const yearMonth = today.slice(0, 7);
  const monthRange = resolveMonthRange(yearMonth);

  const { rows: totalRows } = await getDbPool().query(
    `SELECT COALESCE(SUM(msg_count), 0) AS total_messages,
            COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
            COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens
     FROM daily_usage WHERE user_id = $1`,
    [userId],
  );

  const total = totalRows[0] as {
    total_messages: string | number;
    total_input_tokens: string | number;
    total_output_tokens: string | number;
    total_tokens: string | number;
  };

  const { rows: monthlyRows } = await getDbPool().query(
    `SELECT COALESCE(SUM(msg_count), 0) AS monthly_messages
     FROM daily_usage
     WHERE user_id = $1
       AND date >= $2
       AND date < $3`,
    [userId, monthRange.start, monthRange.end],
  );

  const monthly = monthlyRows[0] as {
    monthly_messages: string | number;
  };

  const { rows: todayRows } = await getDbPool().query(
    `SELECT COALESCE(msg_count, 0) AS today_messages,
            COALESCE(input_tokens, 0) AS today_input_tokens,
            COALESCE(output_tokens, 0) AS today_output_tokens,
            COALESCE(total_tokens, 0) AS today_total_tokens
     FROM daily_usage WHERE user_id = $1 AND date = $2`,
    [userId, today],
  );

  const todayRow = todayRows[0] as
    | {
        today_messages: number;
        today_input_tokens: number;
        today_output_tokens: number;
        today_total_tokens: number;
      }
    | undefined;

  return {
    total_messages: Number(total.total_messages),
    total_input_tokens: Number(total.total_input_tokens),
    total_output_tokens: Number(total.total_output_tokens),
    total_tokens: Number(total.total_tokens),
    monthly_messages: Number(monthly.monthly_messages),
    today_messages: todayRow?.today_messages ?? 0,
    today_input_tokens: todayRow?.today_input_tokens ?? 0,
    today_output_tokens: todayRow?.today_output_tokens ?? 0,
    today_total_tokens: todayRow?.today_total_tokens ?? 0,
  };
}

/**
 * 批量读取用户列表页需要的用量统计，避免管理后台逐用户查询。
 *
 * @param userIds 当前页用户 ID 列表。
 * @returns userId 到用量统计的映射；无用量记录时填充 0。
 */
export async function getUsageStatsByUserIds(
  userIds: string[],
): Promise<Map<string, UsageStats>> {
  const emptyStats = (): UsageStats => ({
    total_messages: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_tokens: 0,
    monthly_messages: 0,
    today_messages: 0,
    today_input_tokens: 0,
    today_output_tokens: 0,
    today_total_tokens: 0,
  });
  const result = new Map(userIds.map((userId) => [userId, emptyStats()]));
  if (userIds.length === 0) return result;

  const today = new Date().toISOString().slice(0, 10);
  const monthRange = resolveMonthRange(today.slice(0, 7));
  const { rows } = await getDbPool().query(
    `SELECT user_id,
            COALESCE(SUM(msg_count), 0) AS total_messages,
            COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
            COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(msg_count) FILTER (
              WHERE date >= $2 AND date < $3
            ), 0) AS monthly_messages,
            COALESCE(SUM(msg_count) FILTER (WHERE date = $4), 0) AS today_messages,
            COALESCE(SUM(input_tokens) FILTER (WHERE date = $4), 0) AS today_input_tokens,
            COALESCE(SUM(output_tokens) FILTER (WHERE date = $4), 0) AS today_output_tokens,
            COALESCE(SUM(total_tokens) FILTER (WHERE date = $4), 0) AS today_total_tokens
     FROM daily_usage
     WHERE user_id = ANY($1::text[])
     GROUP BY user_id`,
    [userIds, monthRange.start, monthRange.end, today],
  );

  for (const row of rows as Array<Record<string, string | number>>) {
    const userId = String(row.user_id);
    result.set(userId, {
      total_messages: Number(row.total_messages),
      total_input_tokens: Number(row.total_input_tokens),
      total_output_tokens: Number(row.total_output_tokens),
      total_tokens: Number(row.total_tokens),
      monthly_messages: Number(row.monthly_messages),
      today_messages: Number(row.today_messages),
      today_input_tokens: Number(row.today_input_tokens),
      today_output_tokens: Number(row.today_output_tokens),
      today_total_tokens: Number(row.today_total_tokens),
    });
  }
  return result;
}

export const __resolveMonthRangeForTests = resolveMonthRange;

export async function getDailyUsageRows(
  userId: string,
): Promise<DailyUsageRow[]> {
  const { rows } = await getDbPool().query(
    `WITH usage_rows AS (
       SELECT date,
              COALESCE(msg_count, 0) AS msg_count,
              COALESCE(input_tokens, 0) AS input_tokens,
              COALESCE(output_tokens, 0) AS output_tokens,
              COALESCE(total_tokens, 0) AS total_tokens
       FROM daily_usage
       WHERE user_id = $1
     ),
     charge_rows AS (
       SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
              COALESCE(SUM(-amount_coins), 0) AS official_model_charge_coins
       FROM wallet_transactions
       WHERE user_id = $1
         AND kind = 'overage_charge'
         AND amount_coins < 0
       GROUP BY 1
     ),
     daily_dates AS (
       SELECT date FROM usage_rows
       UNION
       SELECT date FROM charge_rows
     )
     SELECT daily_dates.date,
            COALESCE(usage_rows.msg_count, 0) AS msg_count,
            COALESCE(usage_rows.input_tokens, 0) AS input_tokens,
            COALESCE(usage_rows.output_tokens, 0) AS output_tokens,
            COALESCE(usage_rows.total_tokens, 0) AS total_tokens,
            COALESCE(charge_rows.official_model_charge_coins, 0) AS official_model_charge_coins
     FROM daily_dates
     LEFT JOIN usage_rows ON usage_rows.date = daily_dates.date
     LEFT JOIN charge_rows ON charge_rows.date = daily_dates.date
     ORDER BY daily_dates.date DESC`,
    [userId],
  );

  return rows.map((row) => {
    const item = row as {
      date: string;
      msg_count: string | number;
      input_tokens: string | number;
      output_tokens: string | number;
      total_tokens: string | number;
      official_model_charge_coins: string | number;
    };
    return {
      date: item.date,
      msg_count: Number(item.msg_count),
      input_tokens: Number(item.input_tokens),
      output_tokens: Number(item.output_tokens),
      total_tokens: Number(item.total_tokens),
      official_model_charge_coins: Number(item.official_model_charge_coins),
    };
  });
}

/**
 * 汇总管理后台完整运行状态统计。
 *
 * @returns 今日消息、用户规模、处理队列和最近 Token 趋势。
 */
export async function getAdminStatusStats(): Promise<AdminStatusStats> {
  const today = new Date().toISOString().slice(0, 10);
  const [userCount, todayUsage, processingSessions, tokenUsageSeries] =
    await Promise.all([
      getDbPool().query(`SELECT COUNT(*) AS cnt FROM users`),
      getDbPool().query(
        `SELECT COALESCE(SUM(msg_count), 0) AS today_messages,
              COALESCE(SUM(total_tokens), 0) AS today_total_tokens
       FROM daily_usage
       WHERE date = $1`,
        [today],
      ),
      countProcessingSessions(),
      getPublicStatusTokenUsageSeries(),
    ]);
  const usage = todayUsage.rows[0] as {
    today_messages: string | number;
    today_total_tokens: string | number;
  };

  return {
    today_messages: Number(usage.today_messages),
    registered_users: Number((userCount.rows[0] as { cnt: string }).cnt),
    today_total_tokens: Number(usage.today_total_tokens),
    processing_sessions: processingSessions,
    token_usage_series: tokenUsageSeries,
  };
}
