import type {
  ServiceStatusDetailsDto,
  ServiceStatusOverviewDto,
  ServiceStatusSampleDto,
} from '@fateclaw/contracts/service-status';
import {
  listServiceStatusChecks,
  getServiceTokenUsage,
  SERVICE_CHECK_INTERVAL_SECONDS,
  SERVICE_STATUS_STALE_SECONDS,
} from '#infrastructure/repositories/service-status-repository';
import { getBenefitSupply } from '#infrastructure/repositories/benefit-repository';

export function publicServiceStatus(
  history: ServiceStatusSampleDto[],
  now = Date.now(),
): ServiceStatusDetailsDto {
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
  const [paidHistory, benefitHistory, supply, tokenUsage] = await Promise.all([
    listServiceStatusChecks(),
    listServiceStatusChecks('benefit'),
    getBenefitSupply(),
    getServiceTokenUsage(),
  ]);
  const official = publicServiceStatus(paidHistory);
  const benefit = publicServiceStatus(benefitHistory);
  return {
    ...official,
    probe_kind: 'http_head',
    token_usage: tokenUsage,
    services: [
      { ...official, pool_key: 'official', display_name: '付费模型服务' },
      {
        ...benefit,
        pool_key: 'benefit',
        display_name: '免费模型服务',
        supply,
        supply_checked_at: new Date().toISOString(),
      },
    ],
  };
}
