import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDbPool } = vi.hoisted(() => ({
  mockGetDbPool: vi.fn(),
}));

vi.mock('./db.js', () => ({
  getDbPool: mockGetDbPool,
}));

import { getDailyUsageRows } from './daily-usage.js';

describe('daily usage repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns daily token usage with official model charge points', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          date: '2026-05-28',
          msg_count: '2',
          input_tokens: '1200',
          output_tokens: '800',
          total_tokens: '2000',
          official_model_charge_points: '36',
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
        official_model_charge_points: 36,
      },
    ]);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('wallet_transactions'),
      ['user-1'],
    );
    expect(query.mock.calls[0]?.[0]).toContain("kind = 'overage_charge'");
  });
});
