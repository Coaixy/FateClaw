import { describe, expect, it } from 'vitest';
import {
  serviceStatusHistory,
  visibleServiceStatus,
  visibleBenefitSupply,
} from '@/features/service-status/history';
import type {
  ServiceStatusOverviewDto,
  ServiceStatusServiceDto,
} from '@fateclaw/contracts/service-status';

describe('service status history', () => {
  it('separates fresh quota exhaustion from service failure and expires stale supply evidence', () => {
    const now = Date.parse('2026-10-16T06:00:00Z');
    const service: ServiceStatusServiceDto = {
      pool_key: 'benefit',
      display_name: 'Benefits',
      status: 'operational',
      checked_at: new Date(now).toISOString(),
      supply_checked_at: new Date(now).toISOString(),
      supply: 'exhausted',
      latency_ms: 25,
      check_interval_seconds: 21600,
      stale_after_seconds: 43200,
      history: [],
    };
    expect(visibleBenefitSupply(service, now)).toBe('exhausted');
    expect(
      visibleBenefitSupply(
        { ...service, supply: 'available', status: 'unavailable' },
        now,
      ),
    ).toBe('unavailable');
    expect(visibleBenefitSupply(service, now + 600001)).toBe('unknown');
  });
  it('keeps unmeasured six-hour intervals unknown instead of inventing availability', () => {
    const samples = [
      {
        checked_at: '2026-10-15T06:10:00Z',
        status: 'operational' as const,
        latency_ms: 20,
      },
    ];
    const slots = serviceStatusHistory(
      samples,
      Date.parse('2026-10-15T12:00:00Z'),
    );
    expect(slots).toHaveLength(28);
    expect(slots.filter(Boolean)).toEqual(samples);
    expect(slots[27]).toBeNull();
  });
  it('expires a previously loaded green status even if later page refreshes fail', () => {
    const data: ServiceStatusOverviewDto = {
      status: 'operational',
      checked_at: '2026-10-15T00:00:00Z',
      latency_ms: 20,
      check_interval_seconds: 21600,
      stale_after_seconds: 43200,
      history: [],
    };
    expect(visibleServiceStatus(data, Date.parse('2026-10-15T12:00:00Z'))).toBe(
      'operational',
    );
    expect(visibleServiceStatus(data, Date.parse('2026-10-15T12:00:01Z'))).toBe(
      'unknown',
    );
  });
});
