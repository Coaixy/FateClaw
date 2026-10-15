import type {
  ServiceStatusSampleDto,
  ServiceStatusOverviewDto,
} from '@fateclaw/contracts/service-status';

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
