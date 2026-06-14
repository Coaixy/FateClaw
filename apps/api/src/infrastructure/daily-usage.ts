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

export async function getDailyMessageCount(
  userId: string,
  date: string,
): Promise<number> {
  const { rows } = await getDbPool().query(
    'SELECT msg_count FROM daily_usage WHERE user_id = $1 AND date = $2',
    [userId, date],
  );
  return (rows[0] as { msg_count: number } | undefined)?.msg_count ?? 0;
}

export async function incrementDailyMessageCount(
  userId: string,
  date: string,
): Promise<void> {
  await getDbPool().query(
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
): Promise<void> {
  await getDbPool().query(
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
  const { rows } = await getDbPool().query(
    `SELECT COALESCE(SUM(total_tokens), 0) AS total
     FROM daily_usage WHERE user_id = $1 AND date LIKE $2`,
    [userId, `${ym}%`],
  );
  return Number((rows[0] as { total: string | number }).total);
}

export async function getUsageStats(userId: string): Promise<UsageStats> {
  const today = new Date().toISOString().slice(0, 10);
  const yearMonth = today.slice(0, 7);

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
     FROM daily_usage WHERE user_id = $1 AND date LIKE $2`,
    [userId, `${yearMonth}%`],
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
