import { getDbPool } from './db.js';

export interface DailyUsageRow {
  date: string;
  msg_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  official_model_charge_points: number;
}

export interface UsageStats {
  total_messages: number;
  total_input_tokens: number;
  total_output_tokens: number;
  today_messages: number;
  today_input_tokens: number;
  today_output_tokens: number;
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
): Promise<void> {
  await getDbPool().query(
    `INSERT INTO daily_usage (user_id, date, msg_count, input_tokens, output_tokens)
     VALUES ($1, $2, 0, $3, $4)
     ON CONFLICT (user_id, date) DO UPDATE SET
       input_tokens = daily_usage.input_tokens + $3,
       output_tokens = daily_usage.output_tokens + $4`,
    [userId, date, inputTokens, outputTokens],
  );
}

export async function getMonthlyTokenUsage(
  userId: string,
  yearMonth?: string,
): Promise<number> {
  const ym = yearMonth ?? new Date().toISOString().slice(0, 7);
  const { rows } = await getDbPool().query(
    `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total
     FROM daily_usage WHERE user_id = $1 AND date LIKE $2`,
    [userId, `${ym}%`],
  );
  return Number((rows[0] as { total: string | number }).total);
}

export async function getUsageStats(userId: string): Promise<UsageStats> {
  const today = new Date().toISOString().slice(0, 10);

  const { rows: totalRows } = await getDbPool().query(
    `SELECT COALESCE(SUM(msg_count), 0) AS total_messages,
            COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
            COALESCE(SUM(output_tokens), 0) AS total_output_tokens
     FROM daily_usage WHERE user_id = $1`,
    [userId],
  );

  const total = totalRows[0] as {
    total_messages: string | number;
    total_input_tokens: string | number;
    total_output_tokens: string | number;
  };

  const { rows: todayRows } = await getDbPool().query(
    `SELECT COALESCE(msg_count, 0) AS today_messages,
            COALESCE(input_tokens, 0) AS today_input_tokens,
            COALESCE(output_tokens, 0) AS today_output_tokens
     FROM daily_usage WHERE user_id = $1 AND date = $2`,
    [userId, today],
  );

  const todayRow = todayRows[0] as
    | {
        today_messages: number;
        today_input_tokens: number;
        today_output_tokens: number;
      }
    | undefined;

  return {
    total_messages: Number(total.total_messages),
    total_input_tokens: Number(total.total_input_tokens),
    total_output_tokens: Number(total.total_output_tokens),
    today_messages: todayRow?.today_messages ?? 0,
    today_input_tokens: todayRow?.today_input_tokens ?? 0,
    today_output_tokens: todayRow?.today_output_tokens ?? 0,
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
              COALESCE(input_tokens + output_tokens, 0) AS total_tokens
       FROM daily_usage
       WHERE user_id = $1
     ),
     charge_rows AS (
       SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
              COALESCE(SUM(-amount_points), 0) AS official_model_charge_points
       FROM wallet_transactions
       WHERE user_id = $1
         AND kind = 'overage_charge'
         AND amount_points < 0
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
            COALESCE(charge_rows.official_model_charge_points, 0) AS official_model_charge_points
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
      official_model_charge_points: string | number;
    };
    return {
      date: item.date,
      msg_count: Number(item.msg_count),
      input_tokens: Number(item.input_tokens),
      output_tokens: Number(item.output_tokens),
      total_tokens: Number(item.total_tokens),
      official_model_charge_points: Number(item.official_model_charge_points),
    };
  });
}
