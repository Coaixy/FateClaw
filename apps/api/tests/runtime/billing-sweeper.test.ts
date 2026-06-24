import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockListStalePendingReservations,
  mockGetConversationLogByRequestId,
  mockRecoverStalePendingReservation,
} = vi.hoisted(() => ({
  mockListStalePendingReservations: vi.fn(),
  mockGetConversationLogByRequestId: vi.fn(),
  mockRecoverStalePendingReservation: vi.fn(),
}));

vi.mock('../../src/infrastructure/db.js', () => ({
  listStalePendingReservations: mockListStalePendingReservations,
  getConversationLogByRequestId: mockGetConversationLogByRequestId,
}));

vi.mock('../../src/modules/billing/plans.js', () => ({
  recoverStalePendingReservation: mockRecoverStalePendingReservation,
}));

vi.mock('../../src/infrastructure/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { runBillingSweepOnce } from '../../src/runtime/billing-sweeper.js';

const isoMinutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60 * 1000).toISOString();

describe('billing sweeper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConversationLogByRequestId.mockResolvedValue(undefined);
    mockRecoverStalePendingReservation.mockResolvedValue({
      actualChargeCoins: 0,
      rawChargeCoins: 0,
    });
  });

  it('按对话日志真实用量补结算有日志的预留', async () => {
    mockListStalePendingReservations.mockResolvedValueOnce([
      {
        request_id: 'req-with-log',
        user_id: 'user-1',
        charge_state: 'pending',
        created_at: isoMinutesAgo(10),
      },
    ]);
    mockGetConversationLogByRequestId.mockResolvedValueOnce({
      request_id: 'req-with-log',
      usage: { promptTokens: 1200, completionTokens: 340, totalTokens: 1540 },
    });
    mockRecoverStalePendingReservation.mockResolvedValueOnce({
      actualChargeCoins: 0.04,
      rawChargeCoins: 0.04,
    });

    await runBillingSweepOnce();

    expect(mockRecoverStalePendingReservation).toHaveBeenCalledWith({
      requestId: 'req-with-log',
      promptTokens: 1200,
      completionTokens: 340,
    });
  });

  it('无对话日志且超过丢失阈值的预留按 0 关账', async () => {
    mockListStalePendingReservations.mockResolvedValueOnce([
      {
        request_id: 'req-lost',
        user_id: 'user-1',
        charge_state: 'pending',
        // 3 小时前，远超 2 小时丢失阈值，且无对话日志。
        created_at: isoMinutesAgo(180),
      },
    ]);

    await runBillingSweepOnce();

    expect(mockRecoverStalePendingReservation).toHaveBeenCalledWith({
      requestId: 'req-lost',
      promptTokens: 0,
      completionTokens: 0,
    });
  });

  it('无对话日志但未超丢失阈值的预留跳过（可能仍在途）', async () => {
    mockListStalePendingReservations.mockResolvedValueOnce([
      {
        request_id: 'req-maybe-inflight',
        user_id: 'user-1',
        charge_state: 'pending',
        // 30 分钟前：超过最小处理年龄但远未到丢失阈值，且暂无日志。
        created_at: isoMinutesAgo(30),
      },
    ]);

    await runBillingSweepOnce();

    expect(mockRecoverStalePendingReservation).not.toHaveBeenCalled();
  });
});
