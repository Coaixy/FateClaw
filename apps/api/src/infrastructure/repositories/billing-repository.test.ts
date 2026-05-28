import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDbPool, mockGetUserByIdUsing, mockLoggerWarn } = vi.hoisted(
  () => ({
    mockGetDbPool: vi.fn(),
    mockGetUserByIdUsing: vi.fn(),
    mockLoggerWarn: vi.fn(),
  }),
);

vi.mock('../db-pool.js', () => ({
  getDbPool: mockGetDbPool,
}));

vi.mock('./users-repository.js', () => ({
  getUserByIdUsing: mockGetUserByIdUsing,
}));

vi.mock('../logger.js', () => ({
  logger: {
    warn: mockLoggerWarn,
  },
}));

vi.mock('../config.js', () => ({
  JWT_SECRET: 'test-secret',
  WITHDRAWAL_ENCRYPTION_KEY:
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
}));

import {
  deductPoints,
  getVisibleWalletTransactionsByUserId,
  insertRechargeOrder,
  listBillingRequestReservations,
  reserveUserPoints,
  settleRechargeOrderPaid,
} from './billing-repository.js';

interface QueryCall {
  sql: string;
  params?: unknown[];
}

type MockQueryResult = unknown[] | { rows?: unknown[]; rowCount?: number };

function normalizeResult(result: MockQueryResult | undefined) {
  if (Array.isArray(result)) return { rows: result, rowCount: result.length };
  return {
    rows: result?.rows ?? [],
    rowCount: result?.rowCount ?? result?.rows?.length ?? 0,
  };
}

function createMockPool(
  poolResults: MockQueryResult[] = [],
  clientResults: MockQueryResult[] = [],
) {
  const calls: QueryCall[] = [];
  const clientCalls: QueryCall[] = [];
  let poolIdx = 0;
  let clientIdx = 0;
  const client = {
    async query(sql: string, params?: unknown[]) {
      clientCalls.push({ sql, params });
      return normalizeResult(clientResults[clientIdx++]);
    },
    release: vi.fn(),
  };
  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return normalizeResult(poolResults[poolIdx++]);
    },
    async connect() {
      return client;
    },
  };
  mockGetDbPool.mockReturnValue(pool);
  return { calls, clientCalls, client };
}

describe('billing repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts recharge orders and serializes metadata', async () => {
    const { calls } = createMockPool([[{ id: 'order-1' }]]);

    await expect(
      insertRechargeOrder({
        id: 'order-1',
        userId: 'user-1',
        tradeId: 'trade-1',
        payType: 'alipay',
        amountYuan: '9.90',
        amountPoints: 990,
        metadata: { plan: 'basic' },
      }),
    ).resolves.toEqual({ id: 'order-1' });

    expect(calls[0]?.sql).toContain('INSERT INTO recharge_orders');
    expect(calls[0]?.params).toEqual([
      'order-1',
      'user-1',
      'trade-1',
      'alipay',
      '9.90',
      990,
      JSON.stringify({ plan: 'basic' }),
    ]);
  });

  it('settles pending recharge orders transactionally and writes wallet flow', async () => {
    const order = {
      id: 'order-1',
      user_id: 'user-1',
      trade_id: 'trade-1',
      provider: 'epay',
      provider_trade_id: null,
      pay_type: 'alipay',
      amount_yuan: '9.90',
      amount_points: 990,
      status: 'pending',
    };
    const updated = { ...order, status: 'paid' };
    const { clientCalls, client } = createMockPool(
      [],
      [[], [order], [], [], [updated], []],
    );

    await expect(
      settleRechargeOrderPaid({
        tradeId: 'trade-1',
        providerTradeId: 'provider-1',
        payType: 'wechat',
      }),
    ).resolves.toEqual(updated);

    expect(clientCalls[0]?.sql).toBe('BEGIN');
    expect(clientCalls[1]?.sql).toContain('FOR UPDATE');
    expect(clientCalls[2]?.sql).toContain('SET purchased_points');
    expect(clientCalls[3]?.sql).toContain('INSERT INTO wallet_transactions');
    expect(clientCalls[3]?.params?.[1]).toBe('user-1');
    expect(clientCalls[3]?.params?.[3]).toBe(990);
    expect(clientCalls[4]?.sql).toContain('UPDATE recharge_orders');
    expect(clientCalls[5]?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('excludes official model token charges from visible wallet flow', async () => {
    const { calls } = createMockPool();

    await expect(
      getVisibleWalletTransactionsByUserId('user-1', 20),
    ).resolves.toEqual([]);

    expect(calls[0]?.sql).toContain("kind <> 'overage_charge'");
    expect(calls[0]?.params).toEqual(['user-1', 20]);
  });

  it('caps billing reservation list filters and keeps params ordered', async () => {
    const { calls } = createMockPool();

    await listBillingRequestReservations({
      userId: 'user-1',
      holdState: 'held',
      chargeState: 'pending',
      limit: 999,
    });

    expect(calls[0]?.sql).toContain('user_id = $1');
    expect(calls[0]?.sql).toContain('hold_state = $2');
    expect(calls[0]?.sql).toContain('charge_state = $3');
    expect(calls[0]?.sql).toContain('LIMIT $4');
    expect(calls[0]?.params).toEqual(['user-1', 'held', 'pending', 200]);
  });

  it('reserves only currently spendable points', async () => {
    const user = {
      id: 'user-1',
      purchased_points: 10,
      bonus_points: 2,
      reserved_points: 3,
    };
    const updated = { ...user, reserved_points: 12 };
    mockGetUserByIdUsing.mockResolvedValue(user);
    const { clientCalls, client } = createMockPool(
      [],
      [[], [], [updated], [], []],
    );

    await expect(
      reserveUserPoints({
        userId: 'user-1',
        amountPoints: 20,
        requestId: 'request-1',
        yearMonth: '2026-05',
      }),
    ).resolves.toEqual({
      user: updated,
      reservedPoints: 9,
    });

    expect(clientCalls[0]?.sql).toBe('BEGIN');
    expect(mockGetUserByIdUsing).toHaveBeenCalledWith(client, 'user-1', {
      forUpdate: true,
    });
    expect(clientCalls[2]?.sql).toContain('SET reserved_points');
    expect(clientCalls[2]?.params).toEqual([9, 'user-1']);
    expect(clientCalls[3]?.sql).toContain(
      'INSERT INTO billing_request_reservations',
    );
    expect(clientCalls[3]?.params?.slice(0, 6)).toEqual([
      'request-1',
      'user-1',
      null,
      '2026-05',
      9,
      'held',
    ]);
    expect(clientCalls[4]?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('deducts bonus batches before purchased points', async () => {
    const clientCalls: QueryCall[] = [];
    const client = {
      async query(sql: string, params?: unknown[]) {
        clientCalls.push({ sql, params });
        if (sql.includes('FROM point_batches')) {
          return normalizeResult([
            { id: 'batch-1', remaining_points: 3 },
            { id: 'batch-2', remaining_points: 10 },
          ]);
        }
        return normalizeResult([]);
      },
    };

    await expect(
      deductPoints(
        client as never,
        {
          id: 'user-1',
          purchased_points: 5,
          bonus_points: 10,
          reserved_points: 0,
        } as never,
        8,
      ),
    ).resolves.toEqual({
      bonusDeducted: 8,
      purchasedDeducted: 0,
      batchDeductions: [
        { batchId: 'batch-1', points: 3 },
        { batchId: 'batch-2', points: 5 },
      ],
      pointSource: 'bonus',
    });

    expect(clientCalls[1]?.sql).toContain('UPDATE point_batches');
    expect(clientCalls[1]?.params).toEqual([3, 'batch-1']);
    expect(clientCalls[2]?.params).toEqual([5, 'batch-2']);
    expect(clientCalls[3]?.sql).toContain('SET bonus_points');
    expect(clientCalls[3]?.params).toEqual([8, 0, 'user-1']);
  });
});
