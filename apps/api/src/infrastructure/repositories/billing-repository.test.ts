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

import {
  createDailySignInReward,
  deductBalanceCoins,
  getVisibleWalletTransactionsByUserId,
  insertRechargeOrder,
  listBillingRequestReservations,
  reserveUserBalanceCoins,
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
        amountCoins: 10,
        metadata: { plan: 'basic' },
      }),
    ).resolves.toEqual({ id: 'order-1' });

    expect(calls[0]?.sql).toContain('INSERT INTO recharge_orders');
    expect(calls[0]?.params).toEqual([
      'order-1',
      'user-1',
      'trade-1',
      'alipay',
      10,
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
      amount_coins: 10,
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
    expect(clientCalls[2]?.sql).toContain('SET purchased_coins');
    expect(clientCalls[3]?.sql).toContain('INSERT INTO wallet_transactions');
    expect(clientCalls[3]?.params?.[1]).toBe('user-1');
    expect(clientCalls[3]?.params?.[3]).toBe(10);
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

  it('creates daily sign-in rewards transactionally', async () => {
    const user = {
      id: 'user-1',
      purchased_coins: 100,
      bonus_coins: 10,
      reserved_coins: 0,
    };
    const record = {
      id: 'signin-1',
      user_id: 'user-1',
      sign_in_date: '2026-05-30',
      reward_coins: 20,
      balance_grant_id: 'bg-1',
      created_at: '2026-05-30T00:00:00.000Z',
    };
    const updated = { ...user, bonus_coins: 30 };
    mockGetUserByIdUsing.mockResolvedValue(user);
    const { clientCalls, client } = createMockPool(
      [],
      [[], [record], [], [updated], [], []],
    );

    await expect(
      createDailySignInReward({
        userId: 'user-1',
        signInDate: '2026-05-30',
        rewardCoins: 20,
      }),
    ).resolves.toEqual({
      user: updated,
      record,
      created: true,
    });

    expect(clientCalls[0]?.sql).toBe('BEGIN');
    expect(clientCalls[1]?.sql).toContain('INSERT INTO daily_sign_in_records');
    expect(clientCalls[2]?.sql).toContain('INSERT INTO balance_grants');
    expect(clientCalls[3]?.sql).toContain('SET bonus_coins');
    expect(clientCalls[4]?.sql).toContain('INSERT INTO wallet_transactions');
    expect(clientCalls[5]?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('does not grant twice when daily sign-in record already exists', async () => {
    const user = {
      id: 'user-1',
      purchased_coins: 100,
      bonus_coins: 10,
      reserved_coins: 0,
    };
    const existingRecord = {
      id: 'signin-existing',
      user_id: 'user-1',
      sign_in_date: '2026-05-30',
      reward_coins: 20,
      balance_grant_id: 'bg-existing',
      created_at: '2026-05-30T00:00:00.000Z',
    };
    mockGetUserByIdUsing.mockResolvedValue(user);
    const { clientCalls, client } = createMockPool(
      [],
      [[], [], [existingRecord], []],
    );

    await expect(
      createDailySignInReward({
        userId: 'user-1',
        signInDate: '2026-05-30',
        rewardCoins: 20,
      }),
    ).resolves.toEqual({
      user,
      record: existingRecord,
      created: false,
    });

    expect(clientCalls[1]?.sql).toContain('INSERT INTO daily_sign_in_records');
    expect(clientCalls[2]?.sql).toContain('FROM daily_sign_in_records');
    expect(
      clientCalls.some((call) => call.sql.includes('SET bonus_coins')),
    ).toBe(false);
    expect(clientCalls[3]?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('reserves only currently spendable balance', async () => {
    const user = {
      id: 'user-1',
      purchased_coins: 10,
      bonus_coins: 2,
      reserved_coins: 3,
    };
    const updated = { ...user, reserved_coins: 12 };
    mockGetUserByIdUsing.mockResolvedValue(user);
    const { clientCalls, client } = createMockPool(
      [],
      [[], [], [updated], [], []],
    );

    await expect(
      reserveUserBalanceCoins({
        userId: 'user-1',
        amountCoins: 20,
        requestId: 'request-1',
        yearMonth: '2026-05',
      }),
    ).resolves.toEqual({
      user: updated,
      reservedCoins: 9,
    });

    expect(clientCalls[0]?.sql).toBe('BEGIN');
    expect(mockGetUserByIdUsing).toHaveBeenCalledWith(client, 'user-1', {
      forUpdate: true,
    });
    expect(clientCalls[2]?.sql).toContain('SET reserved_coins');
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

  it('deducts bonus grants before purchased balance', async () => {
    const clientCalls: QueryCall[] = [];
    const client = {
      async query(sql: string, params?: unknown[]) {
        clientCalls.push({ sql, params });
        if (sql.includes('FROM balance_grants')) {
          return normalizeResult([
            { id: 'batch-1', remaining_coins: 3 },
            { id: 'batch-2', remaining_coins: 10 },
          ]);
        }
        return normalizeResult([]);
      },
    };

    await expect(
      deductBalanceCoins(
        client as never,
        {
          id: 'user-1',
          purchased_coins: 5,
          bonus_coins: 10,
          reserved_coins: 0,
        } as never,
        8,
      ),
    ).resolves.toEqual({
      bonusDeducted: 8,
      purchasedDeducted: 0,
      grantDeductions: [
        { grantId: 'batch-1', coins: 3 },
        { grantId: 'batch-2', coins: 5 },
      ],
      balanceSource: 'bonus',
    });

    expect(clientCalls[1]?.sql).toContain('UPDATE balance_grants');
    expect(clientCalls[1]?.params).toEqual([3, 'batch-1']);
    expect(clientCalls[2]?.params).toEqual([5, 'batch-2']);
    expect(clientCalls[3]?.sql).toContain('SET bonus_coins');
    expect(clientCalls[3]?.params).toEqual([8, 0, 'user-1']);
  });
});
