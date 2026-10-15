import { randomUUID } from 'node:crypto';
import type { ServiceStatusSampleDto } from '@fateclaw/contracts/service-status';
import { getDbPool } from '../db-pool.js';

export const SERVICE_CHECK_INTERVAL_SECONDS = 6 * 60 * 60;
export const SERVICE_STATUS_STALE_SECONDS = 12 * 60 * 60;

export async function claimServiceStatusCheck(): Promise<string | null> {
  const token = randomUUID();
  // Reserve the interval before the external call; restarts cannot multiply probe traffic.
  const result = await getDbPool().query(
    `UPDATE ai_service_status_schedule SET lease_token=$1,
       lease_until=now()+interval '5 minutes', next_check_at=now()+make_interval(secs=>$2)
     WHERE id='ai' AND next_check_at<=now() AND (lease_until IS NULL OR lease_until<=now())
     RETURNING id`,
    [token, SERVICE_CHECK_INTERVAL_SECONDS],
  );
  return result.rowCount ? token : null;
}

export async function completeServiceStatusCheck(
  token: string,
  sample: ServiceStatusSampleDto,
): Promise<void> {
  await getDbPool().query(
    `WITH owned AS (
       UPDATE ai_service_status_schedule SET lease_token=NULL, lease_until=NULL
       WHERE id='ai' AND lease_token=$1 AND lease_until>now() RETURNING id
     ), saved AS (
       INSERT INTO ai_service_status_checks (checked_at,status,latency_ms)
       SELECT $2::timestamptz,$3,$4 FROM owned ON CONFLICT (checked_at) DO NOTHING RETURNING checked_at
     )
     DELETE FROM ai_service_status_checks WHERE checked_at<now()-interval '7 days'
       AND EXISTS (SELECT 1 FROM saved)`,
    [token, sample.checked_at, sample.status, sample.latency_ms],
  );
}

export async function listServiceStatusChecks(): Promise<
  ServiceStatusSampleDto[]
> {
  const { rows } = await getDbPool().query<{
    checked_at: Date;
    status: ServiceStatusSampleDto['status'];
    latency_ms: number | null;
  }>(
    'SELECT checked_at,status,latency_ms FROM ai_service_status_checks ORDER BY checked_at DESC LIMIT 28',
  );
  return rows.map((row) => ({
    checked_at: row.checked_at.toISOString(),
    status: row.status,
    latency_ms: row.latency_ms,
  }));
}
