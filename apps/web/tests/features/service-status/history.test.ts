import { describe, expect, it } from 'vitest';
import {
  serviceStatusHistory,
  visibleServiceStatus,
} from '@/features/service-status/history';
import type { ServiceStatusOverviewDto } from '@fateclaw/contracts/service-status';

describe('service status history', () => {
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
