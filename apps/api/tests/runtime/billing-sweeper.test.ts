import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockDurableQuery,
  mockListStalePendingReservations,
  mockGetConversationLogByRequestId,
  mockRecoverStalePendingReservation,
} = vi.hoisted(() => ({
  mockDurableQuery: vi.fn(async () => ({ rowCount: 0, rows: [] })),
  mockListStalePendingReservations: vi.fn(),
  mockGetConversationLogByRequestId: vi.fn(),
  mockRecoverStalePendingReservation: vi.fn(),
}));

vi.mock('#infrastructure/db-pool', () => ({
  getDbPool: () => ({ query: mockDurableQuery }),
}));
vi.mock('#infrastructure/db', () => ({
  listStalePendingReservations: mockListStalePendingReservations,
  getConversationLogByRequestId: mockGetConversationLogByRequestId,
}));

vi.mock('#modules/billing/plans', () => ({
  recoverStalePendingReservation: mockRecoverStalePendingReservation,
}));

vi.mock('#infrastructure/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('#infrastructure/alerts', () => ({
  sendOpsAlert: vi.fn(async () => undefined),
}));

import { runBillingSweepOnce } from '#runtime/billing-sweeper';

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

  it('preserves unresolved durable execution reservations for late actual usage', async () => {
    mockListStalePendingReservations.mockResolvedValueOnce([
      {
        request_id: 'unknown',
        user_id: 'user',
        created_at: '2020-01-01T00:00:00Z',
      },
    ]);
    mockDurableQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await runBillingSweepOnce();
    expect(mockRecoverStalePendingReservation).not.toHaveBeenCalled();
  });

  it('settles known durable usage even when message delivery rolled back its conversation log', async () => {
    mockListStalePendingReservations.mockResolvedValueOnce([
      {
        request_id: 'delivery-failed',
        user_id: 'user',
        created_at: isoMinutesAgo(10),
      },
    ]);
    mockDurableQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          state: 'result_ready',
          result: {
            usage: {
              promptTokens: 120,
              completionTokens: 30,
              totalTokens: 200,
            },
          },
        },
      ],
    } as never);
    await runBillingSweepOnce();
    expect(mockRecoverStalePendingReservation).toHaveBeenCalledWith({
      requestId: 'delivery-failed',
      promptTokens: 170,
      completionTokens: 30,
    });
  });

  it.each([
    {
      state: 'interrupted',
      result: { usage: { promptTokens: 0, completionTokens: 0 } },
    },
    {
      state: 'result_ready',
      result: {
        metadata: { synthetic_terminal: true },
        usage: { promptTokens: 0 },
      },
    },
    { state: 'result_ready', result: {} },
  ])('keeps unknown or synthetic durable usage pending: %j', async (row) => {
    mockListStalePendingReservations.mockResolvedValueOnce([
      {
        request_id: 'unknown',
        user_id: 'user',
        created_at: isoMinutesAgo(180),
      },
    ]);
    mockDurableQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [row],
    } as never);
    await runBillingSweepOnce();
    expect(mockRecoverStalePendingReservation).not.toHaveBeenCalled();
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
