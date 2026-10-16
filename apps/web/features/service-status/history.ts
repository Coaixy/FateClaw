import type {
  ServiceStatusSampleDto,
  ServiceStatusOverviewDto,
  ServiceStatusServiceDto,
} from '@fateclaw/contracts/service-status';

export function visibleBenefitSupply(
  service: ServiceStatusServiceDto,
  now = Date.now(),
): 'available' | 'busy' | 'exhausted' | 'disabled' | 'unknown' | 'unavailable' {
  const checked = Date.parse(service.supply_checked_at ?? '');
  if (!Number.isFinite(checked) || now - checked > 600_000) return 'unknown';
  if (service.supply === 'disabled' || service.supply === 'exhausted')
    return service.supply;
  const health = visibleServiceStatus(service, now);
  if (health === 'unavailable') return 'unavailable';
  if (service.supply === 'busy') return 'busy';
  return health === 'operational' && service.supply === 'available'
    ? 'available'
    : 'unknown';
}

export function visibleServiceStatus(
  data: ServiceStatusOverviewDto,
  now = Date.now(),
) {
  return data.checked_at &&
    now - Date.parse(data.checked_at) <= data.stale_after_seconds * 1000
    ? data.status
    : 'unknown';
}

export function serviceStatusHistory(
  history: ServiceStatusSampleDto[],
  now = Date.now(),
): Array<ServiceStatusSampleDto | null> {
  const slotMs = 6 * 60 * 60 * 1000;
  const end = Math.floor(now / slotMs) * slotMs;
  return Array.from({ length: 28 }, (_, index) => {
    const start = end - (27 - index) * slotMs;
    return (
      history.find((sample) => {
        const checked = Date.parse(sample.checked_at);
        return checked >= start && checked < start + slotMs;
      }) ?? null
    );
  });
}
