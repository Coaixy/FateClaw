import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDbPool } = vi.hoisted(() => ({
  mockGetDbPool: vi.fn(),
}));

vi.mock('../../src/infrastructure/db.js', () => ({
  getDbPool: mockGetDbPool,
}));

import {
  __resolveMonthRangeForTests,
  getDailyUsageRows,
  getMonthlyTokenUsage,
  incrementDailyTokens,
} from '../../src/infrastructure/daily-usage.js';

describe('daily usage repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns daily token usage with official model charge coins', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          date: '2026-05-28',
          msg_count: '2',
          input_tokens: '1200',
          output_tokens: '800',
          total_tokens: '2000',
          official_model_charge_coins: '36',
        },
      ],
    });
    mockGetDbPool.mockReturnValue({ query });

    await expect(getDailyUsageRows('user-1')).resolves.toEqual([
      {
        date: '2026-05-28',
        msg_count: 2,
        input_tokens: 1200,
        output_tokens: 800,
        total_tokens: 2000,
        official_model_charge_coins: 36,
      },
    ]);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('wallet_transactions'),
      ['user-1'],
    );
    expect(query.mock.calls[0]?.[0]).toContain("kind = 'overage_charge'");
  });

  it('stores Pi total tokens separately from input and output splits', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    mockGetDbPool.mockReturnValue({ query });

    await incrementDailyTokens(
      'user-1',
      '2026-05-30',
      500_000,
      20_000,
      900_000,
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('total_tokens'),
      ['user-1', '2026-05-30', 500_000, 20_000, 900_000],
    );
    expect(query.mock.calls[0]?.[0]).toContain(
      'total_tokens = daily_usage.total_tokens + $5',
    );
  });

  it('uses stored total tokens for monthly usage summaries', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ total: '9000000' }],
    });
    mockGetDbPool.mockReturnValue({ query });

    await expect(getMonthlyTokenUsage('user-1', '2026-05')).resolves.toBe(
      9_000_000,
    );
    expect(query.mock.calls[0]?.[0]).toContain('SUM(total_tokens)');
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'user-1',
      '2026-05-01',
      '2026-06-01',
    ]);
  });

  it('resolves December month range across year boundary', () => {
    expect(__resolveMonthRangeForTests('2026-12')).toEqual({
      start: '2026-12-01',
      end: '2027-01-01',
    });
  });
});
