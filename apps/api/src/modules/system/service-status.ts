import type {
  ServiceStatusOverviewDto,
  ServiceStatusSampleDto,
} from '@fateclaw/contracts/service-status';
import {
  listServiceStatusChecks,
  SERVICE_CHECK_INTERVAL_SECONDS,
  SERVICE_STATUS_STALE_SECONDS,
} from '../../infrastructure/repositories/service-status-repository.js';

export function publicServiceStatus(
  history: ServiceStatusSampleDto[],
  now = Date.now(),
): ServiceStatusOverviewDto {
  const latest = history[0];
  const fresh =
    latest &&
    now - Date.parse(latest.checked_at) <= SERVICE_STATUS_STALE_SECONDS * 1000;
  return {
    status: fresh ? latest.status : 'unknown',
    checked_at: latest?.checked_at ?? null,
    latency_ms:
      fresh && latest.status === 'operational' ? latest.latency_ms : null,
    check_interval_seconds: SERVICE_CHECK_INTERVAL_SECONDS,
    stale_after_seconds: SERVICE_STATUS_STALE_SECONDS,
    // Whitelist public fields even if internal storage later grows private diagnostics.
    history: history.map((sample) => ({
      checked_at: sample.checked_at,
      status: sample.status,
      latency_ms: sample.latency_ms,
    })),
  };
}

export async function getPublicServiceStatus(): Promise<ServiceStatusOverviewDto> {
  return publicServiceStatus(await listServiceStatusChecks());
}
