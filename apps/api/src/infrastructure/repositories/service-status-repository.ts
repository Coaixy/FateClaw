import { randomUUID } from 'node:crypto';
import type {
  ServiceStatusSampleDto,
  ServiceTokenUsageDto,
} from '@fateclaw/contracts/service-status';
import { getDbPool } from '#infrastructure/db-pool';

export const SERVICE_CHECK_INTERVAL_SECONDS = 6 * 60 * 60;
export const SERVICE_STATUS_STALE_SECONDS = 12 * 60 * 60;

export async function getServiceTokenUsage(): Promise<ServiceTokenUsageDto> {
  const { rows } = await getDbPool().query<{
    total_tokens: string;
    today_tokens: string;
    updated_at: Date;
    daily: { date: string; tokens: number }[];
  }>(
    `WITH daily AS MATERIALIZED (
       SELECT date, SUM(total_tokens) AS tokens FROM daily_usage GROUP BY date
     ), clock AS (
       SELECT (statement_timestamp() AT TIME ZONE 'UTC')::date AS today
     )
     SELECT COALESCE((SELECT SUM(tokens) FROM daily), 0) AS total_tokens,
       COALESCE((SELECT tokens FROM daily, clock WHERE date = clock.today::text), 0) AS today_tokens,
       statement_timestamp() AS updated_at,
       (SELECT json_agg(json_build_object(
           'date', to_char(day, 'YYYY-MM-DD'), 'tokens', COALESCE(daily.tokens, 0)
         ) ORDER BY day)
        FROM clock, generate_series(clock.today - 6, clock.today, interval '1 day') AS day
        LEFT JOIN daily ON daily.date = to_char(day, 'YYYY-MM-DD')) AS daily`,
  );
  const row = rows[0];
  return {
    total_tokens: Number(row.total_tokens),
    today_tokens: Number(row.today_tokens),
    updated_at: row.updated_at.toISOString(),
    daily: row.daily.map((point) => ({
      date: point.date,
      tokens: Number(point.tokens),
    })),
  };
}

export async function claimServiceStatusCheck(
  poolKey: 'official' | 'benefit' = 'official',
): Promise<string | null> {
  const token = randomUUID();
  // Reserve the interval before the external call; restarts cannot multiply probe traffic.
  const result = await getDbPool().query(
    `UPDATE ai_service_status_schedule SET lease_token=$1,
       lease_until=now()+interval '5 minutes', next_check_at=now()+make_interval(secs=>$2)
     WHERE id=$3 AND next_check_at<=now() AND (lease_until IS NULL OR lease_until<=now())
     RETURNING id`,
    [
      token,
      SERVICE_CHECK_INTERVAL_SECONDS,
      poolKey === 'benefit' ? 'benefit' : 'ai',
    ],
  );
  return result.rowCount ? token : null;
}

export async function completeServiceStatusCheck(
  token: string,
  sample: ServiceStatusSampleDto,
  poolKey: 'official' | 'benefit' = 'official',
): Promise<void> {
  await getDbPool().query(
    `WITH owned AS (
       UPDATE ai_service_status_schedule SET lease_token=NULL, lease_until=NULL
       WHERE id=$5 AND lease_token=$1 AND lease_until>now() RETURNING id
     ), saved AS (
       INSERT INTO ai_service_status_checks (checked_at,status,latency_ms,pool_key)
       SELECT $2::timestamptz,$3,$4,$6 FROM owned ON CONFLICT (pool_key,checked_at) DO NOTHING RETURNING checked_at
     )
     DELETE FROM ai_service_status_checks WHERE checked_at<now()-interval '7 days'
       AND EXISTS (SELECT 1 FROM saved)`,
    [
      token,
      sample.checked_at,
      sample.status,
      sample.latency_ms,
      poolKey === 'benefit' ? 'benefit' : 'ai',
      poolKey,
    ],
  );
}

export async function listServiceStatusChecks(
  poolKey: 'official' | 'benefit' = 'official',
): Promise<ServiceStatusSampleDto[]> {
  const { rows } = await getDbPool().query<{
    checked_at: Date;
    status: ServiceStatusSampleDto['status'];
    latency_ms: number | null;
  }>(
    'SELECT checked_at,status,latency_ms FROM ai_service_status_checks WHERE pool_key=$1 ORDER BY checked_at DESC LIMIT 28',
    [poolKey],
  );
  return rows.map((row) => ({
    checked_at: row.checked_at.toISOString(),
    status: row.status,
    latency_ms: row.latency_ms,
  }));
}
