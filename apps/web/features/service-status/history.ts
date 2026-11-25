import type {
  ServiceStatusDetailsDto,
  ServiceStatusSampleDto,
  ServiceStatusServiceDto,
} from '@fateclaw/contracts/service-status';
import type { BenefitSupplyState } from '@fateclaw/contracts/model-settings';

export function visibleBenefitSupply(
  service: ServiceStatusServiceDto,
  now = Date.now(),
): BenefitSupplyState {
  const checked = Date.parse(service.supply_checked_at ?? '');
  if (!Number.isFinite(checked) || now - checked > 600_000) return 'unknown';
  return service.supply ?? 'unknown';
}

export function visibleServiceStatus(
  data: ServiceStatusDetailsDto,
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
