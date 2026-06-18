import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDbPool, mockGetUserByIdUsing, mockLoggerWarn } = vi.hoisted(
  () => ({
    mockGetDbPool: vi.fn(),
    mockGetUserByIdUsing: vi.fn(),
    mockLoggerWarn: vi.fn(),
  }),
);

vi.mock('../../../src/infrastructure/db-pool.js', () => ({
  getDbPool: mockGetDbPool,
}));

vi.mock('../../../src/infrastructure/repositories/users-repository.js', () => ({
  getUserByIdUsing: mockGetUserByIdUsing,
}));

vi.mock('../../../src/infrastructure/logger.js', () => ({
  logger: {
    warn: mockLoggerWarn,
  },
}));

import {
  claimProfessionalAiTurn,
  createDailySignInReward,
  deductBalanceCoins,
  deductModelChargeCoinsAllowDebt,
  getFreeProfessionalAiQuotaConfig,
  getMembershipOverview,
  getMembershipOverviewsByUserIds,
  getMembershipEntitlements,
  getVisibleWalletTransactionsByUserId,
  insertRechargeOrder,
  reconcileStaleBillingReservations,
  expireUserBonusBalanceBefore,
  listBillingRequestReservations,
  listBillingRequestReservationsPageForAdmin,
  listRechargeOrdersForAdmin,
  listWalletTransactionsForAdmin,
  releaseProfessionalAiTurn,
  reserveUserBalanceCoins,
  settleRechargeOrderPaid,
  setUserMembershipForAdmin,
  subscribeMembershipWithWallet,
  cancelUserMembershipsForAdmin,
  cancelUserMembershipPlanForAdmin,
  updateFreeProfessionalAiQuotaConfig,
} from '../../../src/infrastructure/repositories/billing-repository.js';

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

  afterEach(() => {
    vi.useRealTimers();
  });

  it('inserts recharge orders and serializes metadata', async () => {
    const { calls } = createMockPool([[{ id: 'order-1', amount_coins: 10 }]]);

    await expect(
      insertRechargeOrder({
        id: 'order-1',
        userId: 'user-1',
        tradeId: 'trade-1',
        payType: 'alipay',
        amountCoins: 10,
        metadata: { plan: 'basic' },
      }),
    ).resolves.toEqual({ id: 'order-1', amount_coins: 10 });

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
    expect(calls[0]?.sql).toContain('LIMIT $4 OFFSET $5');
    expect(calls[0]?.params).toEqual(['user-1', 'held', 'pending', 200, 0]);
  });

  it('selects stale billing reservations in SQL before reconciliation', async () => {
    const { calls } = createMockPool([[]]);

    await expect(
      reconcileStaleBillingReservations('2026-05-30T00:00:00.000Z', 999),
    ).resolves.toEqual({ released: 0, requestIds: [] });

    expect(calls[0]?.sql).toContain("hold_state = 'held'");
    expect(calls[0]?.sql).toContain("charge_state = 'pending'");
    expect(calls[0]?.sql).toContain('updated_at < $1');
    expect(calls[0]?.sql).toContain('ORDER BY updated_at ASC');
    expect(calls[0]?.params).toEqual(['2026-05-30T00:00:00.000Z', 200]);
  });

  it('lists admin billing reservations with filters and total count', async () => {
    const { calls } = createMockPool([
      [{ cnt: '6' }],
      [
        {
          request_id: 'request-1',
          user_id: 'user-1',
          reserved_coins: '1.25',
          actual_charge_coins: '0.5',
          total_overage_cost_coins: '0.5',
        },
      ],
    ]);

    await expect(
      listBillingRequestReservationsPageForAdmin({
        userId: 'user-1',
        holdState: 'held',
        chargeState: 'pending',
        limit: 20,
        offset: 40,
      }),
    ).resolves.toEqual({
      reservations: [
        {
          request_id: 'request-1',
          user_id: 'user-1',
          reserved_coins: 1.25,
          actual_charge_coins: 0.5,
          total_overage_cost_coins: 0.5,
        },
      ],
      total: 6,
    });

    expect(calls[0]?.sql).toContain('FROM billing_request_reservations');
    expect(calls[0]?.sql).toContain('user_id = $1');
    expect(calls[0]?.sql).toContain('hold_state = $2');
    expect(calls[0]?.sql).toContain('charge_state = $3');
    expect(calls[1]?.sql).toContain('LIMIT $4 OFFSET $5');
    expect(calls[1]?.params).toEqual(['user-1', 'held', 'pending', 20, 40]);
  });

  it('lists admin recharge orders with filters and total count', async () => {
    const { calls } = createMockPool([
      [{ cnt: '3' }],
      [
        {
          id: 'order-1',
          user_id: 'user-1',
          user_phone: '13800138000',
          amount_coins: '19.5',
        },
      ],
    ]);

    await expect(
      listRechargeOrdersForAdmin({
        userId: 'user-1',
        status: 'paid',
        payType: 'wechat',
        limit: 500,
        offset: 10,
      }),
    ).resolves.toEqual({
      orders: [
        {
          id: 'order-1',
          user_id: 'user-1',
          user_phone: '13800138000',
          amount_coins: 19.5,
        },
      ],
      total: 3,
    });

    expect(calls[0]?.sql).toContain('FROM recharge_orders ro');
    expect(calls[0]?.sql).toContain('ro.user_id = $1');
    expect(calls[0]?.sql).toContain('ro.status = $2');
    expect(calls[0]?.sql).toContain('ro.pay_type = $3');
    expect(calls[1]?.sql).toContain('LEFT JOIN users u ON u.id = ro.user_id');
    expect(calls[1]?.sql).toContain('LIMIT $4 OFFSET $5');
    expect(calls[1]?.params).toEqual(['user-1', 'paid', 'wechat', 200, 10]);
  });

  it('lists admin wallet transactions with filters and total count', async () => {
    const { calls } = createMockPool([
      [{ cnt: '2' }],
      [
        {
          id: 'tx-1',
          user_id: 'user-1',
          user_phone: null,
          kind: 'overage_charge',
          amount_coins: '-0.25',
          reserved_delta_coins: '0',
        },
      ],
    ]);

    await expect(
      listWalletTransactionsForAdmin({
        userId: 'user-1',
        kind: 'overage_charge',
        limit: 30,
        offset: 5,
      }),
    ).resolves.toEqual({
      transactions: [
        {
          id: 'tx-1',
          user_id: 'user-1',
          user_phone: null,
          kind: 'overage_charge',
          amount_coins: -0.25,
          reserved_delta_coins: 0,
        },
      ],
      total: 2,
    });

    expect(calls[0]?.sql).toContain('FROM wallet_transactions wt');
    expect(calls[0]?.sql).toContain('wt.user_id = $1');
    expect(calls[0]?.sql).toContain('wt.kind = $2');
    expect(calls[1]?.sql).toContain('LEFT JOIN users u ON u.id = wt.user_id');
    expect(calls[1]?.sql).toContain('LIMIT $3 OFFSET $4');
    expect(calls[1]?.params).toEqual(['user-1', 'overage_charge', 30, 5]);
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

  it('reads and normalizes Free professional AI quota config', async () => {
    const { calls } = createMockPool([
      [
        {
          id: 'default',
          daily_professional_turn_limit: '5',
          updated_at: '2026-05-30T00:00:00.000Z',
        },
      ],
    ]);

    await expect(getFreeProfessionalAiQuotaConfig()).resolves.toEqual({
      id: 'default',
      daily_professional_turn_limit: 5,
      updated_at: '2026-05-30T00:00:00.000Z',
    });
    expect(calls[0]?.sql).toContain('INSERT INTO ai_chat_free_quota_config');
  });

  it('updates Free professional AI quota config with integer limits', async () => {
    const { calls } = createMockPool([
      [
        {
          id: 'default',
          daily_professional_turn_limit: '4',
          updated_at: '2026-05-30T00:00:00.000Z',
        },
      ],
    ]);

    await expect(
      updateFreeProfessionalAiQuotaConfig({
        dailyProfessionalTurnLimit: 4.8,
      }),
    ).resolves.toMatchObject({
      daily_professional_turn_limit: 4,
    });
    expect(calls[0]?.params).toEqual([4]);
  });

  it('claims a professional AI turn when quota remains', async () => {
    const { clientCalls, client } = createMockPool(
      [],
      [
        [],
        [
          {
            user_id: 'user-1',
            usage_date: '2026-05-30',
            professional_turn_count: '2',
            created_at: '2026-05-30T00:00:00.000Z',
            updated_at: '2026-05-30T00:01:00.000Z',
          },
        ],
        [],
      ],
    );

    await expect(
      claimProfessionalAiTurn({
        userId: 'user-1',
        dailyTurnLimit: 5,
        usageDate: '2026-05-30',
      }),
    ).resolves.toEqual({
      allowed: true,
      usage_date: '2026-05-30',
      limit: 5,
      used: 2,
      remaining: 3,
    });
    expect(clientCalls[0]?.sql).toBe('BEGIN');
    expect(clientCalls[1]?.sql).toContain(
      'ON CONFLICT (user_id, usage_date) DO UPDATE',
    );
    expect(clientCalls[1]?.sql).toContain('professional_turn_count < $3');
    expect(clientCalls[1]?.params).toEqual(['user-1', '2026-05-30', 5]);
    expect(clientCalls[2]?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rejects a professional AI turn after quota is exhausted', async () => {
    const { clientCalls, client } = createMockPool(
      [],
      [
        [],
        [],
        [
          {
            user_id: 'user-1',
            usage_date: '2026-05-30',
            professional_turn_count: '5',
            created_at: '2026-05-30T00:00:00.000Z',
            updated_at: '2026-05-30T00:01:00.000Z',
          },
        ],
        [],
      ],
    );

    await expect(
      claimProfessionalAiTurn({
        userId: 'user-1',
        dailyTurnLimit: 5,
        usageDate: '2026-05-30',
      }),
    ).resolves.toEqual({
      allowed: false,
      usage_date: '2026-05-30',
      limit: 5,
      used: 5,
      remaining: 0,
    });
    expect(clientCalls[2]?.sql).toContain(
      'FROM ai_chat_professional_daily_usage',
    );
    expect(clientCalls[3]?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('releases a consumed professional AI turn', async () => {
    const { calls } = createMockPool([
      [
        {
          user_id: 'user-1',
          usage_date: '2026-05-30',
          professional_turn_count: '3',
          created_at: '2026-05-30T00:00:00.000Z',
          updated_at: '2026-05-30T00:01:00.000Z',
        },
      ],
    ]);

    await expect(
      releaseProfessionalAiTurn({
        userId: 'user-1',
        usageDate: '2026-05-30',
      }),
    ).resolves.toEqual({
      released: true,
      usage_date: '2026-05-30',
      used: 3,
    });
    expect(calls[0]?.sql).toContain(
      'UPDATE ai_chat_professional_daily_usage',
    );
    expect(calls[0]?.sql).toContain('professional_turn_count > 0');
    expect(calls[0]?.params).toEqual(['user-1', '2026-05-30']);
  });

  it('records metered requests without reserving balance', async () => {
    const user = {
      id: 'user-1',
      purchased_coins: 10,
      bonus_coins: 2,
      reserved_coins: 3,
    };
    mockGetUserByIdUsing.mockResolvedValue(user);
    const { clientCalls, client } = createMockPool([], [[], [], []]);

    await expect(
      reserveUserBalanceCoins({
        userId: 'user-1',
        amountCoins: 20,
        requestId: 'request-1',
        yearMonth: '2026-05',
      }),
    ).resolves.toEqual({
      user,
      reservedCoins: 0,
    });

    expect(clientCalls[0]?.sql).toBe('BEGIN');
    expect(mockGetUserByIdUsing).toHaveBeenCalledWith(client, 'user-1');
    expect(clientCalls[2]?.sql).toContain(
      'INSERT INTO billing_request_reservations',
    );
    expect(clientCalls[2]?.params?.slice(0, 6)).toEqual([
      'request-1',
      'user-1',
      null,
      '2026-05',
      0,
      'none',
    ]);
    expect(clientCalls[3]?.sql).toBe('COMMIT');
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

  it('allows official model settlement to put purchased balance in debt', async () => {
    const clientCalls: QueryCall[] = [];
    const updated = {
      id: 'user-1',
      purchased_coins: -5,
      bonus_coins: 0,
      reserved_coins: 0,
    };
    const client = {
      async query(sql: string, params?: unknown[]) {
        clientCalls.push({ sql, params });
        if (sql.includes('FROM balance_grants')) {
          return normalizeResult([]);
        }
        if (sql.includes('UPDATE users')) {
          return normalizeResult([updated]);
        }
        return normalizeResult([]);
      },
    };

    await expect(
      deductModelChargeCoinsAllowDebt(
        client as never,
        {
          id: 'user-1',
          purchased_coins: 0,
          bonus_coins: 0,
          reserved_coins: 0,
        } as never,
        5,
      ),
    ).resolves.toEqual({
      bonusDeducted: 0,
      purchasedDeducted: 5,
      grantDeductions: [],
      balanceSource: 'purchased',
      user: updated,
    });

    expect(clientCalls[1]?.sql).toContain('SET bonus_coins');
    expect(clientCalls[1]?.params).toEqual([0, 5, 'user-1']);
  });

  it('expires stale user bonus grants before wallet balance reads', async () => {
    mockGetUserByIdUsing.mockResolvedValue({
      id: 'user-1',
      purchased_coins: 0,
      bonus_coins: 8,
      reserved_coins: 0,
    });
    const grant = {
      id: 'grant-1',
      user_id: 'user-1',
      source: 'daily_sign_in',
      granted_by: null,
      amount_coins: 8,
      remaining_coins: 5,
      note: null,
      expires_at: '2026-05-01T00:00:00.000Z',
      status: 'active',
      created_at: '2026-04-01T00:00:00.000Z',
      updated_at: '2026-04-01T00:00:00.000Z',
    };
    const { clientCalls, client } = createMockPool(
      [],
      [[], [grant], [], [], [], []],
    );

    await expect(
      expireUserBonusBalanceBefore('user-1', '2026-06-01T00:00:00.000Z'),
    ).resolves.toEqual({ expired: 1, totalCoinsExpired: 5 });

    expect(mockGetUserByIdUsing).toHaveBeenCalledWith(client, 'user-1', {
      forUpdate: true,
    });
    expect(clientCalls[1]?.sql).toContain('expires_at < $2');
    expect(clientCalls[2]?.sql).toContain("SET status = 'expired'");
    expect(clientCalls[2]?.params).toEqual([['grant-1']]);
    expect(clientCalls[3]?.sql).toContain('SET bonus_coins');
    expect(clientCalls[3]?.params).toEqual([5, 'user-1']);
    expect(clientCalls[4]?.sql).toContain('INSERT INTO wallet_transactions');
    expect(clientCalls[4]?.params?.[2]).toBe('bonus_expire');
    expect(clientCalls[5]?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('charges the rounded per-request model cost directly', async () => {
    const user = {
      id: 'user-1',
      purchased_coins: 10,
      bonus_coins: 0,
      reserved_coins: 0,
    };
    const reservation = {
      request_id: 'request-1',
      user_id: 'user-1',
      model_config_id: 'model-1',
      year_month: '2026-05',
      reserved_coins: 0,
      hold_state: 'none',
      charge_state: 'pending',
      actual_charge_coins: 0,
      total_overage_tokens: 0,
      total_overage_cost_coins: 0,
    };
    const monthlyState = {
      user_id: 'user-1',
      year_month: '2026-05',
      billed_overage_tokens: 100,
      billed_overage_cost_coins: 2.4,
    };
    const updated = {
      ...user,
      purchased_coins: 9.37,
    };
    const disabledConfig = {
      id: 'default',
      enabled: false,
      monthly_price_coins: 30,
      monthly_allowance_units: 3000000,
      standard_price_per_million_units_coins: 10,
    };
    mockGetUserByIdUsing.mockResolvedValue(user);
    const { clientCalls, client } = createMockPool(
      [],
      [
        [],
        [reservation],
        [],
        [monthlyState],
        [],
        [disabledConfig],
        [],
        [updated],
        [],
        [],
      ],
    );

    const { settleUserModelChargeCoins } =
      await import('../../../src/infrastructure/repositories/billing-repository.js');

    await expect(
      settleUserModelChargeCoins('request-1', 141_873, 0.63),
    ).resolves.toMatchObject({
      actualChargeCoins: 0.63,
      user: updated,
    });

    expect(clientCalls[3]?.sql).toContain('billed_overage_cost_coins');
    const monthlyUpdate = clientCalls.find((call) =>
      call.sql.includes('UPDATE monthly_billing_state'),
    );
    expect(monthlyUpdate?.params).toEqual([141_873, 3.03, 'user-1', '2026-05']);
    expect(
      clientCalls.some(
        (call) =>
          call.sql.includes('INSERT INTO wallet_transactions') &&
          call.params?.[2] === 'overage_charge',
      ),
    ).toBe(true);
    const chargeTransaction = clientCalls.find(
      (call) =>
        call.sql.includes('INSERT INTO wallet_transactions') &&
        call.params?.[2] === 'overage_charge',
    );
    expect(chargeTransaction?.params?.[3]).toBe(-0.63);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('returns existing membership settlement metadata for charged requests', async () => {
    const user = {
      id: 'user-1',
      purchased_coins: 10,
      bonus_coins: 0,
      reserved_coins: 0,
    };
    const reservation = {
      request_id: 'request-1',
      user_id: 'user-1',
      model_config_id: 'model-1',
      year_month: '2026-05',
      reserved_coins: 0,
      hold_state: 'none',
      charge_state: 'charged',
      actual_charge_coins: 0,
      total_overage_tokens: 1000,
      total_overage_cost_coins: 0.63,
    };
    mockGetUserByIdUsing.mockResolvedValue(user);
    const { clientCalls } = createMockPool(
      [],
      [
        [],
        [reservation],
        [
          {
            metadata: {
              rawRequestCostCoins: 0.63,
              membershipCoveredCoins: 0.63,
              membershipConsumedUnits: 63000,
            },
          },
        ],
        [],
      ],
    );

    const { settleUserModelChargeCoins } =
      await import('../../../src/infrastructure/repositories/billing-repository.js');

    await expect(
      settleUserModelChargeCoins('request-1', 1000, 0.63),
    ).resolves.toMatchObject({
      actualChargeCoins: 0,
      rawChargeCoins: 0.63,
      membershipCoveredCoins: 0.63,
      membershipConsumedUnits: 63000,
      user,
    });

    expect(clientCalls[2]?.sql).toContain('FROM wallet_transactions');
    expect(clientCalls[2]?.params).toEqual(['request-1']);
    expect(
      clientCalls.some((call) =>
        call.sql.includes('UPDATE billing_request_reservations'),
      ),
    ).toBe(false);
  });

  it('uses active membership allowance before charging credit balance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T12:00:00.000Z'));

    const user = {
      id: 'user-1',
      purchased_coins: 10,
      bonus_coins: 0,
      reserved_coins: 0,
    };
    const reservation = {
      request_id: 'request-1',
      user_id: 'user-1',
      model_config_id: 'model-1',
      year_month: '2026-05',
      reserved_coins: 0,
      hold_state: 'none',
      charge_state: 'pending',
      actual_charge_coins: 0,
      total_overage_tokens: 0,
      total_overage_cost_coins: 0,
    };
    const monthlyState = {
      user_id: 'user-1',
      year_month: '2026-05',
      billed_overage_tokens: 0,
      billed_overage_cost_coins: 0,
    };
    const config = {
      id: 'default',
      enabled: true,
      monthly_price_coins: 30,
      monthly_allowance_units: 3000000,
      standard_price_per_million_units_coins: 10,
    };
    const membership = {
      user_id: 'user-1',
      plan_key: 'fateclaw_insight',
      status: 'active',
      current_period_start: '2026-05-10T08:00:00.000Z',
      current_period_end: '2026-06-10T08:00:00.000Z',
    };
    const allowance = {
      id: 'allowance-1',
      user_id: 'user-1',
      plan_key: 'fateclaw_insight',
      period_start: '2026-05-10T08:00:00.000Z',
      period_end: '2026-06-10T08:00:00.000Z',
      allowance_units: 3000000,
      used_units: 0,
    };
    mockGetUserByIdUsing.mockResolvedValue(user);
    const { clientCalls } = createMockPool(
      [],
      [
        [],
        [reservation],
        [],
        [monthlyState],
        [membership],
        [config],
        [allowance],
        [{ ...allowance, used_units: 63000 }],
        [],
        [],
        [],
        [],
      ],
    );

    const { settleUserModelChargeCoins } =
      await import('../../../src/infrastructure/repositories/billing-repository.js');

    await expect(
      settleUserModelChargeCoins('request-1', 1000, 0.63),
    ).resolves.toMatchObject({
      actualChargeCoins: 0,
    });

    expect(
      clientCalls.some(
        (call) =>
          call.sql.includes('INSERT INTO wallet_transactions') &&
          call.params?.[2] === 'membership_allowance_use',
      ),
    ).toBe(true);
    const allowanceInsert = clientCalls.find((call) =>
      call.sql.includes('INSERT INTO membership_allowances'),
    );
    expect(allowanceInsert?.params?.slice(3, 5)).toEqual([
      '2026-05-10T08:00:00.000Z',
      '2026-06-10T08:00:00.000Z',
    ]);
    expect(
      clientCalls.some(
        (call) =>
          call.sql.includes('INSERT INTO wallet_transactions') &&
          call.params?.[2] === 'overage_charge',
      ),
    ).toBe(false);
  });

  it('opens membership by deducting credit balance and creating a monthly allowance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-31T00:00:00.000Z'));

    const user = {
      id: 'user-1',
      purchased_coins: 50,
      bonus_coins: 0,
      reserved_coins: 0,
    };
    mockGetUserByIdUsing
      .mockResolvedValueOnce(user)
      .mockResolvedValueOnce({ ...user, purchased_coins: 20 });
    const { clientCalls } = createMockPool(
      [],
      [
        [],
        [
          {
            id: 'default',
            enabled: true,
            monthly_price_coins: 30,
            monthly_allowance_units: 3000000,
            standard_price_per_million_units_coins: 10,
          },
        ],
        [],
        [],
        [],
        [
          {
            user_id: 'user-1',
            plan_key: 'fateclaw_insight',
            status: 'active',
            current_period_start: '2026-05-31T00:00:00.000Z',
            current_period_end: '2026-06-30T00:00:00.000Z',
          },
        ],
        [
          {
            id: 'allowance-1',
            user_id: 'user-1',
            plan_key: 'fateclaw_insight',
            period_start: '2026-05-31T00:00:00.000Z',
            period_end: '2026-06-30T00:00:00.000Z',
            allowance_units: 3000000,
            used_units: 0,
          },
        ],
        [],
      ],
    );

    await expect(
      subscribeMembershipWithWallet('user-1'),
    ).resolves.toMatchObject({
      user: { purchased_coins: 20 },
      overview: { active: true },
    });
    expect(
      clientCalls.some(
        (call) =>
          call.sql.includes('INSERT INTO wallet_transactions') &&
          call.params?.[2] === 'membership_subscription',
      ),
    ).toBe(true);
    const allowanceInsert = clientCalls.find((call) =>
      call.sql.includes('INSERT INTO membership_allowances'),
    );
    expect(allowanceInsert?.params?.slice(3, 5)).toEqual([
      '2026-05-31T00:00:00.000Z',
      '2026-06-30T00:00:00.000Z',
    ]);
  });

  it('reopens expired membership with a fresh allowance anchor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T03:00:00.000Z'));

    const user = {
      id: 'user-1',
      purchased_coins: 50,
      bonus_coins: 0,
      reserved_coins: 0,
    };
    mockGetUserByIdUsing
      .mockResolvedValueOnce(user)
      .mockResolvedValueOnce({ ...user, purchased_coins: 20 });
    const { clientCalls } = createMockPool(
      [],
      [
        [],
        [
          {
            id: 'default',
            enabled: true,
            monthly_price_coins: 30,
            monthly_allowance_units: 3000000,
            standard_price_per_million_units_coins: 10,
          },
        ],
        [],
        [],
        [],
        [
          {
            user_id: 'user-1',
            plan_key: 'fateclaw_insight',
            status: 'active',
            current_period_start: '2026-07-10T03:00:00.000Z',
            current_period_end: '2026-08-10T03:00:00.000Z',
            created_at: '2026-01-10T03:00:00.000Z',
          },
        ],
        [
          {
            id: 'allowance-1',
            user_id: 'user-1',
            plan_key: 'fateclaw_insight',
            period_start: '2026-07-10T03:00:00.000Z',
            period_end: '2026-08-10T03:00:00.000Z',
            allowance_units: 3000000,
            used_units: 0,
          },
        ],
        [],
      ],
    );

    await subscribeMembershipWithWallet('user-1', 'fateclaw_insight');

    const membershipInsert = clientCalls.find((call) =>
      call.sql.includes('INSERT INTO user_memberships'),
    );
    expect(membershipInsert?.params?.slice(2, 4)).toEqual([
      '2026-07-10T03:00:00.000Z',
      '2026-08-10T03:00:00.000Z',
    ]);
    const allowanceInsert = clientCalls.find((call) =>
      call.sql.includes('INSERT INTO membership_allowances'),
    );
    expect(allowanceInsert?.params?.slice(3, 5)).toEqual([
      '2026-07-10T03:00:00.000Z',
      '2026-08-10T03:00:00.000Z',
    ]);
  });

  it('extends membership by clamping month-end renewal periods without moving the reset anchor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));

    const user = {
      id: 'user-1',
      purchased_coins: 60,
      bonus_coins: 0,
      reserved_coins: 0,
    };
    const currentMembership = {
      user_id: 'user-1',
      plan_key: 'fateclaw_insight',
      status: 'active',
      current_period_start: '2026-07-31T08:00:00.000Z',
      current_period_end: '2026-08-31T08:00:00.000Z',
      created_at: '2026-07-31T08:00:00.000Z',
    };
    mockGetUserByIdUsing
      .mockResolvedValueOnce(user)
      .mockResolvedValueOnce({ ...user, purchased_coins: 30 });
    const { clientCalls } = createMockPool(
      [],
      [
        [],
        [
          {
            id: 'default',
            enabled: true,
            monthly_price_coins: 30,
            monthly_allowance_units: 3000000,
            standard_price_per_million_units_coins: 10,
          },
        ],
        [],
        [],
        [currentMembership],
        [
          {
            ...currentMembership,
            current_period_end: '2026-09-30T08:00:00.000Z',
          },
        ],
        [
          {
            id: 'allowance-1',
            user_id: 'user-1',
            plan_key: 'fateclaw_insight',
            period_start: '2026-07-31T08:00:00.000Z',
            period_end: '2026-08-31T08:00:00.000Z',
            allowance_units: 3000000,
            used_units: 0,
          },
        ],
        [],
      ],
    );

    await subscribeMembershipWithWallet('user-1', 'fateclaw_insight');

    const membershipInsert = clientCalls.find((call) =>
      call.sql.includes('INSERT INTO user_memberships'),
    );
    expect(membershipInsert?.params?.slice(2, 4)).toEqual([
      '2026-07-31T08:00:00.000Z',
      '2026-09-30T08:00:00.000Z',
    ]);
  });

  it('inserts a Deep overlay and pauses the existing Insight period', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T00:00:00.000Z'));

    const user = {
      id: 'user-1',
      purchased_coins: 200,
      bonus_coins: 0,
      reserved_coins: 0,
    };
    const insightMembership = {
      user_id: 'user-1',
      plan_key: 'fateclaw_insight',
      status: 'active',
      current_period_start: '2026-06-01T00:00:00.000Z',
      current_period_end: '2027-06-01T00:00:00.000Z',
      created_at: '2026-06-01T00:00:00.000Z',
    };
    mockGetUserByIdUsing
      .mockResolvedValueOnce(user)
      .mockResolvedValueOnce({ ...user, purchased_coins: 100 });
    const { clientCalls } = createMockPool(
      [],
      [
        [],
        [
          {
            id: 'fateclaw_deep',
            enabled: true,
            monthly_price_coins: 100,
            monthly_allowance_units: 10000000,
            standard_price_per_million_units_coins: 10,
          },
        ],
        [],
        [],
        [insightMembership],
        [],
        [
          {
            user_id: 'user-1',
            plan_key: 'fateclaw_deep',
            status: 'active',
            current_period_start: '2026-06-10T00:00:00.000Z',
            current_period_end: '2026-07-10T00:00:00.000Z',
          },
        ],
        [
          {
            id: 'allowance-pro',
            user_id: 'user-1',
            plan_key: 'fateclaw_deep',
            period_start: '2026-06-10T00:00:00.000Z',
            period_end: '2026-07-10T00:00:00.000Z',
            allowance_units: 10000000,
            used_units: 0,
          },
        ],
        [],
      ],
    );

    await subscribeMembershipWithWallet('user-1', 'fateclaw_deep');

    const insightExtend = clientCalls.find(
      (call) =>
        call.sql.includes('UPDATE user_memberships') &&
        call.sql.includes("INTERVAL '1 millisecond'"),
    );
    expect(insightExtend?.params).toEqual([
      'user-1',
      'fateclaw_insight',
      2592000000,
    ]);

    const membershipInsert = clientCalls.find((call) =>
      call.sql.includes('INSERT INTO user_memberships'),
    );
    expect(membershipInsert?.params).toEqual([
      'user-1',
      'fateclaw_deep',
      '2026-06-10T00:00:00.000Z',
      '2026-07-10T00:00:00.000Z',
    ]);
  });

  it('lets admins set membership without charging credit balance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T00:00:00.000Z'));

    mockGetUserByIdUsing.mockResolvedValueOnce({
      id: 'user-1',
      purchased_coins: 0,
      bonus_coins: 0,
      reserved_coins: 0,
    });
    const membership = {
      user_id: 'user-1',
      plan_key: 'fateclaw_insight',
      status: 'active',
      current_period_start: '2026-06-15T00:00:00.000Z',
      current_period_end: '2026-07-31T15:59:59.999Z',
      created_at: '2026-06-15T00:00:00.000Z',
    };
    const { clientCalls } = createMockPool(
      [],
      [
        [],
        [
          {
            id: 'default',
            enabled: true,
            monthly_price_coins: 30,
            monthly_allowance_units: 3000000,
            standard_price_per_million_units_coins: 10,
          },
        ],
        [],
        [membership],
        [
          {
            id: 'allowance-plus',
            user_id: 'user-1',
            plan_key: 'fateclaw_insight',
            period_start: '2026-06-15T00:00:00.000Z',
            period_end: '2026-07-15T00:00:00.000Z',
            allowance_units: 3000000,
            used_units: 0,
          },
        ],
        [],
      ],
    );

    await expect(
      setUserMembershipForAdmin({
        userId: 'user-1',
        planKey: 'fateclaw_insight',
        currentPeriodEnd: '2026-07-31T15:59:59.999Z',
      }),
    ).resolves.toEqual(membership);

    const membershipInsert = clientCalls.find((call) =>
      call.sql.includes('INSERT INTO user_memberships'),
    );
    expect(membershipInsert?.params).toEqual([
      'user-1',
      'fateclaw_insight',
      '2026-06-15T00:00:00.000Z',
      '2026-07-31T15:59:59.999Z',
    ]);
    expect(
      clientCalls.some((call) =>
        call.sql.includes('INSERT INTO wallet_transactions'),
      ),
    ).toBe(false);
  });

  it('lets admins cancel all active membership periods immediately', async () => {
    mockGetUserByIdUsing.mockResolvedValueOnce({
      id: 'user-1',
      purchased_coins: 0,
      bonus_coins: 0,
      reserved_coins: 0,
    });
    const { clientCalls } = createMockPool([], [[], { rowCount: 2 }, []]);

    await expect(cancelUserMembershipsForAdmin('user-1')).resolves.toEqual({
      cancelledCount: 2,
    });

    expect(clientCalls[1]?.sql).toContain("status = 'cancelled'");
    expect(clientCalls[1]?.params).toEqual(['user-1']);
  });

  it('keeps future membership periods valid when admins cancel one plan', async () => {
    mockGetUserByIdUsing.mockResolvedValueOnce({
      id: 'user-1',
      purchased_coins: 0,
      bonus_coins: 0,
      reserved_coins: 0,
    });
    const { clientCalls } = createMockPool([], [[], { rowCount: 1 }, []]);

    await expect(
      cancelUserMembershipPlanForAdmin({
        userId: 'user-1',
        planKey: 'fateclaw_deep',
      }),
    ).resolves.toEqual({ cancelledCount: 1 });

    expect(clientCalls[1]?.sql).toContain(
      "current_period_start + INTERVAL '1 millisecond'",
    );
    expect(clientCalls[1]?.params).toEqual(['user-1', 'fateclaw_deep']);
  });

  it('falls back to Plus after the Pro overlay expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T00:00:01.000Z'));

    const plusMembership = {
      user_id: 'user-1',
      plan_key: 'fateclaw_plus',
      status: 'active',
      current_period_start: '2026-06-01T00:00:00.000Z',
      current_period_end: '2027-07-01T00:00:00.000Z',
      created_at: '2026-06-01T00:00:00.000Z',
    };
    const expiredProMembership = {
      user_id: 'user-1',
      plan_key: 'fateclaw_pro',
      status: 'active',
      current_period_start: '2026-06-10T00:00:00.000Z',
      current_period_end: '2026-07-10T00:00:00.000Z',
      created_at: '2026-06-10T00:00:00.000Z',
    };
    const allowance = {
      id: 'allowance-plus',
      user_id: 'user-1',
      plan_key: 'fateclaw_plus',
      period_start: '2026-07-01T00:00:00.000Z',
      period_end: '2026-08-01T00:00:00.000Z',
      allowance_units: 3000000,
      used_units: 0,
    };
    const { calls } = createMockPool([
      [expiredProMembership, plusMembership],
      [
        {
          id: 'default',
          enabled: true,
          monthly_price_coins: 30,
          monthly_allowance_units: 3000000,
          standard_price_per_million_units_coins: 10,
        },
      ],
      [allowance],
    ]);

    await expect(getMembershipOverview('user-1')).resolves.toMatchObject({
      active: true,
      membership: {
        plan_key: 'fateclaw_plus',
        current_period_end: '2027-07-01T00:00:00.000Z',
      },
      allowance,
    });
    expect(calls[2]?.params).toEqual([
      'user-1',
      'fateclaw_plus',
      '2026-07-01T00:00:00.000Z',
    ]);
  });

  it('returns the effective membership entitlement timeline after a Deep overlay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T00:00:00.000Z'));

    const insightMembership = {
      user_id: 'user-1',
      plan_key: 'fateclaw_insight',
      status: 'active',
      current_period_start: '2026-06-01T00:00:00.000Z',
      current_period_end: '2027-07-01T00:00:00.000Z',
      created_at: '2026-06-01T00:00:00.000Z',
    };
    const deepMembership = {
      user_id: 'user-1',
      plan_key: 'fateclaw_deep',
      status: 'active',
      current_period_start: '2026-06-10T00:00:00.000Z',
      current_period_end: '2026-07-10T00:00:00.000Z',
      created_at: '2026-06-10T00:00:00.000Z',
    };
    const { calls } = createMockPool([
      [insightMembership, deepMembership],
      [
        {
          id: 'fateclaw_clarity',
          enabled: true,
          name: 'FateClaw Clarity',
          monthly_price_coins: 10,
          monthly_allowance_units: 0,
          standard_price_per_million_units_coins: 10,
        },
      ],
      [
        {
          id: 'fateclaw_insight',
          enabled: true,
          name: 'FateClaw Insight',
          monthly_price_coins: 30,
          monthly_allowance_units: 3000000,
          standard_price_per_million_units_coins: 10,
        },
      ],
      [
        {
          id: 'fateclaw_deep',
          enabled: true,
          name: 'FateClaw Deep',
          monthly_price_coins: 100,
          monthly_allowance_units: 10000000,
          standard_price_per_million_units_coins: 10,
        },
      ],
    ]);

    await expect(getMembershipEntitlements('user-1')).resolves.toEqual([
      {
        plan_key: 'fateclaw_deep',
        name: 'FateClaw Deep',
        effective_start: '2026-06-10T00:00:00.000Z',
        effective_end: '2026-07-10T00:00:00.000Z',
        is_current: true,
      },
      {
        plan_key: 'fateclaw_insight',
        name: 'FateClaw Insight',
        effective_start: '2026-07-10T00:00:00.000Z',
        effective_end: '2027-07-01T00:00:00.000Z',
        is_current: false,
      },
    ]);
    expect(calls[0]?.sql).toContain('FROM user_memberships');
    expect(calls[0]?.params).toEqual(['user-1', '2026-06-15T00:00:00.000Z']);
  });

  it('keeps historical Pro entitlement even when the Deep plan is disabled for new purchases', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T00:00:00.000Z'));

    const plusMembership = {
      user_id: 'user-1',
      plan_key: 'fateclaw_plus',
      status: 'active',
      current_period_start: '2026-06-01T00:00:00.000Z',
      current_period_end: '2027-07-01T00:00:00.000Z',
      created_at: '2026-06-01T00:00:00.000Z',
    };
    const proMembership = {
      user_id: 'user-1',
      plan_key: 'fateclaw_pro',
      status: 'active',
      current_period_start: '2026-06-10T00:00:00.000Z',
      current_period_end: '2026-07-10T00:00:00.000Z',
      created_at: '2026-06-10T00:00:00.000Z',
    };
    const allowance = {
      id: 'allowance-pro',
      user_id: 'user-1',
      plan_key: 'fateclaw_pro',
      period_start: '2026-06-10T00:00:00.000Z',
      period_end: '2026-07-10T00:00:00.000Z',
      allowance_units: 10000000,
      used_units: 0,
    };
    const { calls } = createMockPool([
      [proMembership, plusMembership],
      [
        {
          id: 'fateclaw_pro',
          enabled: false,
          monthly_price_coins: 100,
          monthly_allowance_units: 10000000,
          standard_price_per_million_units_coins: 10,
        },
      ],
      [allowance],
    ]);

    await expect(getMembershipOverview('user-1')).resolves.toMatchObject({
      active: true,
      membership: {
        plan_key: 'fateclaw_pro',
      },
      allowance,
    });
    expect(calls[2]?.params).toEqual([
      'user-1',
      'fateclaw_pro',
      '2026-06-10T00:00:00.000Z',
    ]);
  });

  it('reads the current personal allowance cycle even after historical renewal moved membership period start forward', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));

    const membership = {
      user_id: 'user-1',
      plan_key: 'fateclaw_plus',
      status: 'active',
      current_period_start: '2026-06-30T00:00:00.000Z',
      current_period_end: '2026-07-30T00:00:00.000Z',
      created_at: '2026-05-30T00:00:00.000Z',
    };
    const allowance = {
      id: 'allowance-1',
      user_id: 'user-1',
      plan_key: 'fateclaw_plus',
      period_start: '2026-05-30T00:00:00.000Z',
      period_end: '2026-06-30T00:00:00.000Z',
      allowance_units: 3000000,
      used_units: 42,
    };
    const { calls } = createMockPool([
      [membership],
      [
        {
          id: 'default',
          enabled: true,
          monthly_price_coins: 30,
          monthly_allowance_units: 3000000,
          standard_price_per_million_units_coins: 10,
        },
      ],
      [allowance],
    ]);

    await expect(getMembershipOverview('user-1')).resolves.toMatchObject({
      active: true,
      allowance,
    });
    expect(calls[2]?.params).toEqual([
      'user-1',
      'fateclaw_plus',
      '2026-05-30T00:00:00.000Z',
    ]);
  });

  it('casts batch membership allowance period filters as timestamps', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));

    const membership = {
      user_id: 'user-1',
      plan_key: 'fateclaw_insight',
      status: 'active',
      current_period_start: '2026-05-30T00:00:00.000Z',
      current_period_end: '2026-06-30T00:00:00.000Z',
      created_at: '2026-05-30T00:00:00.000Z',
      updated_at: '2026-05-30T00:00:00.000Z',
    };
    const allowance = {
      id: 'allowance-1',
      user_id: 'user-1',
      plan_key: 'fateclaw_insight',
      period_start: '2026-05-30T00:00:00.000Z',
      period_end: '2026-06-30T00:00:00.000Z',
      allowance_units: 3000000,
      used_units: 42,
      created_at: '2026-05-30T00:00:00.000Z',
      updated_at: '2026-05-30T00:00:00.000Z',
    };
    const config = {
      id: 'fateclaw_insight',
      enabled: true,
      monthly_price_coins: 30,
      monthly_allowance_units: 3000000,
      standard_price_per_million_units_coins: 10,
    };
    const { calls } = createMockPool([
      [config],
      [config],
      [config],
      [membership],
      [allowance],
    ]);

    const overviews = await getMembershipOverviewsByUserIds(['user-1']);

    expect(overviews.get('user-1')).toMatchObject({
      active: true,
      allowance,
    });

    expect(calls[4]?.sql).toContain('period_start = ANY($2::timestamptz[])');
    expect(calls[4]?.params).toEqual([
      ['user-1'],
      ['2026-05-30T00:00:00.000Z'],
    ]);
  });
});
