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
  deductBalanceCoins,
  deductModelChargeCoinsAllowDebt,
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
  reserveUserBalanceCoins,
  settleRechargeOrderPaid,
  setUserMembershipForAdmin,
  subscribeMembershipWithWallet,
  cancelUserMembershipsForAdmin,
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

  it('selects stale pending reservations in SQL before reconciliation', async () => {
    const { calls } = createMockPool([[]]);

    await expect(
      reconcileStaleBillingReservations('2026-05-30T00:00:00.000Z', 999),
    ).resolves.toEqual({ charged: 0, released: 0, requestIds: [] });

    // 放宽到所有 charge_state='pending' 的陈旧预留(不再仅 hold_state='held')。
    expect(calls[0]?.sql).toContain("charge_state = 'pending'");
    expect(calls[0]?.sql).not.toContain("hold_state = 'held'");
    expect(calls[0]?.sql).toContain('updated_at < $1');
    expect(calls[0]?.sql).toContain('ORDER BY updated_at ASC');
    expect(calls[0]?.params).toEqual(['2026-05-30T00:00:00.000Z', 200]);
  });

  it('back-charges held stale reservations by their frozen estimate', async () => {
    const heldReservation = {
      request_id: 'req-stale',
      user_id: 'user-1',
      model_config_id: 'model-1',
      year_month: '2026-05',
      reserved_coins: 0.5,
      hold_state: 'held',
      charge_state: 'pending',
      actual_charge_coins: 0,
      total_overage_tokens: 0,
      total_overage_cost_coins: 0,
    };
    // pool.query 第一次返回待处理预留列表;随后 settleUserModelChargeCoins 走 client 事务。
    const settleUser = {
      id: 'user-1',
      purchased_coins: 9.5,
      bonus_coins: 0,
      reserved_coins: 0.5,
    };
    mockGetUserByIdUsing.mockResolvedValue({
      id: 'user-1',
      purchased_coins: 10,
      bonus_coins: 0,
      reserved_coins: 0.5,
    });
    const { clientCalls } = createMockPool(
      [[heldReservation]],
      [
        [],
        [heldReservation],
        [],
        [{ user_id: 'user-1', year_month: '2026-05', billed_overage_cost_coins: 0 }],
        [],
        [settleUser],
        [],
        [],
        [],
        [],
        [],
      ],
    );

    const result = await reconcileStaleBillingReservations(
      '2026-05-30T00:00:00.000Z',
      100,
    );

    expect(result).toEqual({
      charged: 1,
      released: 0,
      requestIds: ['req-stale'],
    });
    // 补扣走 overage_charge 流水,且带 reconcile 专属备注(索引无关断言)。
    const chargeTx = clientCalls.find(
      (call) =>
        call.sql.includes('INSERT INTO wallet_transactions') &&
        call.params?.includes('overage_charge'),
    );
    expect(chargeTx).toBeTruthy();
    expect(chargeTx?.params).toContain('请求未正常结算,按预冻结额补扣');
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

  it('atomically freezes the estimated reserve into reserved_coins', async () => {
    // 冻结前 reserved=3,冻结 20 后 reserved=23(由条件 UPDATE 的 RETURNING * 返回)。
    const frozenUser = {
      id: 'user-1',
      purchased_coins: 10,
      bonus_coins: 2,
      reserved_coins: 23,
    };
    // client 序列:BEGIN, SELECT reservation FOR UPDATE(无既有), UPDATE users 条件冻结(返回行),
    // INSERT reservation, COMMIT。
    const { clientCalls, client } = createMockPool(
      [],
      [[], [], [frozenUser], [], []],
    );

    await expect(
      reserveUserBalanceCoins({
        userId: 'user-1',
        amountCoins: 20,
        requestId: 'request-1',
        yearMonth: '2026-05',
      }),
    ).resolves.toEqual({
      user: frozenUser,
      reservedCoins: 20,
    });

    expect(clientCalls[0]?.sql).toBe('BEGIN');
    // 既有预留检查
    expect(clientCalls[1]?.sql).toContain('billing_request_reservations');
    expect(clientCalls[1]?.sql).toContain('FOR UPDATE');
    // 原子条件冻结:仅当未欠费时才把预估额加进 reserved_coins
    expect(clientCalls[2]?.sql).toContain('SET reserved_coins = reserved_coins +');
    expect(clientCalls[2]?.sql).toContain(
      '(purchased_coins + bonus_coins - reserved_coins) >= 0',
    );
    expect(clientCalls[2]?.params).toEqual(['user-1', 20]);
    // 成功路径不再单独 getUserById(直接用 UPDATE 的 RETURNING)
    expect(mockGetUserByIdUsing).not.toHaveBeenCalled();
    expect(clientCalls[3]?.sql).toContain(
      'INSERT INTO billing_request_reservations',
    );
    expect(clientCalls[3]?.params?.slice(0, 6)).toEqual([
      'request-1',
      'user-1',
      null,
      '2026-05',
      20,
      'held',
    ]);
    expect(clientCalls[4]?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rejects the reservation when the wallet is already in arrears', async () => {
    mockGetUserByIdUsing.mockResolvedValue({
      id: 'user-1',
      purchased_coins: -1,
      bonus_coins: 0,
      reserved_coins: 0,
    });
    // 条件 UPDATE 命中 0 行(已欠费),随后甄别用户存在 → 抛余额不足,事务回滚。
    const { clientCalls, client } = createMockPool([], [[], [], []]);

    await expect(
      reserveUserBalanceCoins({
        userId: 'user-1',
        amountCoins: 5,
        requestId: 'request-1',
        yearMonth: '2026-05',
      }),
    ).rejects.toThrow('积分不足');

    // 0 行更新后调用 getUserByIdUsing 甄别用户是否存在
    expect(mockGetUserByIdUsing).toHaveBeenCalledWith(client, 'user-1');
    expect(clientCalls.some((c) => c.sql === 'ROLLBACK')).toBe(true);
    expect(
      clientCalls.some((c) =>
        c.sql.includes('INSERT INTO billing_request_reservations'),
      ),
    ).toBe(false);
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
    mockGetUserByIdUsing.mockResolvedValue(user);
    // 单层化后结算 pending 路径不再读 membership_config / allowance，client 查询序列为：
    // BEGIN, SELECT reservation, advisory_lock, INSERT monthly_billing_state,
    // SELECT balance_grants, UPDATE users, UPDATE monthly_billing_state,
    // UPDATE reservation, INSERT wallet_transactions(overage_charge), COMMIT。
    const { clientCalls, client } = createMockPool(
      [],
      [
        [],
        [reservation],
        [],
        [monthlyState],
        [],
        [updated],
        [],
        [],
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

  it('releases the held reserve and charges real cost on settlement', async () => {
    const user = {
      id: 'user-1',
      purchased_coins: 10,
      bonus_coins: 0,
      reserved_coins: 0.5,
    };
    const reservation = {
      request_id: 'request-1',
      user_id: 'user-1',
      model_config_id: 'model-1',
      year_month: '2026-05',
      reserved_coins: 0.5,
      hold_state: 'held',
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
    const deductUpdated = {
      ...user,
      purchased_coins: 9.5,
    };
    mockGetUserByIdUsing.mockResolvedValue(user);
    // 持有冻结的结算序列:BEGIN, SELECT reservation, advisory_lock, INSERT monthly,
    // SELECT balance_grants, UPDATE users(实扣), UPDATE users(释放冻结), UPDATE monthly,
    // UPDATE reservation, INSERT wallet_tx, COMMIT。
    const { clientCalls } = createMockPool(
      [],
      [
        [],
        [reservation],
        [],
        [monthlyState],
        [],
        [deductUpdated],
        [],
        [],
        [],
        [],
        [],
      ],
    );

    const { settleUserModelChargeCoins } = await import(
      '../../../src/infrastructure/repositories/billing-repository.js'
    );

    await expect(
      settleUserModelChargeCoins('request-1', 1000, 0.5),
    ).resolves.toMatchObject({
      actualChargeCoins: 0.5,
      // JS 侧同步把返回用户的冻结额减去已释放的 0.5 → 0。
      user: { reserved_coins: 0 },
    });

    const releaseCall = clientCalls.find((call) =>
      call.sql.includes('SET reserved_coins = GREATEST(0, reserved_coins -'),
    );
    expect(releaseCall).toBeTruthy();
    expect(releaseCall?.params).toEqual([0.5, 'user-1']);
  });

  it('returns existing settlement metadata for already-charged requests idempotently', async () => {
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
      actual_charge_coins: 0.63,
      total_overage_tokens: 1000,
      total_overage_cost_coins: 0.63,
    };
    mockGetUserByIdUsing.mockResolvedValue(user);
    // 单层化后幂等重结算只从 overage_charge 流水回看 rawRequestCostCoins，
    // 不再有 membership_covered/consumed 字段。
    const { clientCalls } = createMockPool(
      [],
      [
        [],
        [reservation],
        [
          {
            metadata: {
              rawRequestCostCoins: 0.63,
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
      actualChargeCoins: 0.63,
      rawChargeCoins: 0.63,
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

  it('opens membership by deducting credit balance for the clarity plan', async () => {
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
    // 单层化后开通流程不再创建 membership_allowance；推荐返利钩子已摘除；client 序列为：
    // BEGIN, INSERT config, SELECT balance_grants, UPDATE users, SELECT active memberships,
    // INSERT user_memberships, INSERT wallet_transactions(membership_subscription), COMMIT。
    const { clientCalls } = createMockPool(
      [],
      [
        [],
        [
          {
            id: 'fateclaw_clarity',
            enabled: true,
            monthly_price_coins: 30,
          },
        ],
        [],
        [],
        [],
        [
          {
            user_id: 'user-1',
            plan_key: 'fateclaw_clarity',
            status: 'active',
            current_period_start: '2026-05-31T00:00:00.000Z',
            current_period_end: '2026-06-30T00:00:00.000Z',
          },
        ],
        [],
        [],
        [],
      ],
    );

    await expect(
      subscribeMembershipWithWallet('user-1'),
    ).resolves.toMatchObject({
      user: { purchased_coins: 20 },
      overview: { active: true },
    });
    const membershipInsert = clientCalls.find((call) =>
      call.sql.includes('INSERT INTO user_memberships'),
    );
    expect(membershipInsert?.params?.slice(0, 2)).toEqual([
      'user-1',
      'fateclaw_clarity',
    ]);
    expect(
      clientCalls.some(
        (call) =>
          call.sql.includes('INSERT INTO wallet_transactions') &&
          call.params?.[2] === 'membership_subscription',
      ),
    ).toBe(true);
    // 单层化后不再写 membership_allowances 表（迁移 0059 已 DROP）。
    expect(
      clientCalls.some((call) =>
        call.sql.includes('INSERT INTO membership_allowances'),
      ),
    ).toBe(false);
  });

  it('reopens an expired membership starting a fresh period from now', async () => {
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
    // 无在售有效会员（idx 4 = []），开通从当前时刻起算一个月。
    const { clientCalls } = createMockPool(
      [],
      [
        [],
        [
          {
            id: 'fateclaw_clarity',
            enabled: true,
            monthly_price_coins: 30,
          },
        ],
        [],
        [],
        [],
        [
          {
            user_id: 'user-1',
            plan_key: 'fateclaw_clarity',
            status: 'active',
            current_period_start: '2026-07-10T03:00:00.000Z',
            current_period_end: '2026-08-10T03:00:00.000Z',
            created_at: '2026-01-10T03:00:00.000Z',
          },
        ],
        [],
        [],
      ],
    );

    // 任何旧档传入都归一为 clarity。
    await subscribeMembershipWithWallet('user-1', 'fateclaw_insight');

    const membershipInsert = clientCalls.find((call) =>
      call.sql.includes('INSERT INTO user_memberships'),
    );
    expect(membershipInsert?.params?.[1]).toBe('fateclaw_clarity');
    expect(membershipInsert?.params?.slice(2, 4)).toEqual([
      '2026-07-10T03:00:00.000Z',
      '2026-08-10T03:00:00.000Z',
    ]);
    expect(
      clientCalls.some((call) =>
        call.sql.includes('INSERT INTO membership_allowances'),
      ),
    ).toBe(false);
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
      plan_key: 'fateclaw_clarity',
      status: 'active',
      current_period_start: '2026-06-15T00:00:00.000Z',
      current_period_end: '2026-07-31T15:59:59.999Z',
      created_at: '2026-06-15T00:00:00.000Z',
    };
    // setUserMembershipForAdmin 序列：BEGIN, INSERT config, SELECT existing membership,
    // INSERT user_memberships, COMMIT（不再创建 allowance）。
    const { clientCalls } = createMockPool(
      [],
      [
        [],
        [
          {
            id: 'fateclaw_clarity',
            enabled: true,
            monthly_price_coins: 30,
          },
        ],
        [],
        [membership],
        [],
      ],
    );

    await expect(
      setUserMembershipForAdmin({
        userId: 'user-1',
        // 任何旧档传入都归一为 clarity。
        planKey: 'fateclaw_insight',
        currentPeriodEnd: '2026-07-31T15:59:59.999Z',
      }),
    ).resolves.toEqual(membership);

    const membershipInsert = clientCalls.find((call) =>
      call.sql.includes('INSERT INTO user_memberships'),
    );
    expect(membershipInsert?.params).toEqual([
      'user-1',
      'fateclaw_clarity',
      '2026-06-15T00:00:00.000Z',
      '2026-07-31T15:59:59.999Z',
    ]);
    expect(
      clientCalls.some((call) =>
        call.sql.includes('INSERT INTO wallet_transactions'),
      ),
    ).toBe(false);
    // 单层化后不再写 membership_allowances。
    expect(
      clientCalls.some((call) =>
        call.sql.includes('INSERT INTO membership_allowances'),
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

  it('returns the single-tier entitlement timeline for an active clarity member', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T00:00:00.000Z'));

    const clarityMembership = {
      user_id: 'user-1',
      plan_key: 'fateclaw_clarity',
      status: 'active',
      current_period_start: '2026-06-01T00:00:00.000Z',
      current_period_end: '2026-07-01T00:00:00.000Z',
      created_at: '2026-06-01T00:00:00.000Z',
    };
    // getMembershipEntitlements 序列：SELECT user_memberships，再 ensure clarity config（仅一次）。
    const { calls } = createMockPool([
      [clarityMembership],
      [
        {
          id: 'fateclaw_clarity',
          enabled: true,
          name: 'FateClaw Clarity',
          monthly_price_coins: 10,
        },
      ],
    ]);

    await expect(getMembershipEntitlements('user-1')).resolves.toEqual([
      {
        plan_key: 'fateclaw_clarity',
        name: 'FateClaw Clarity',
        effective_start: '2026-06-01T00:00:00.000Z',
        effective_end: '2026-07-01T00:00:00.000Z',
        is_current: true,
      },
    ]);
    expect(calls[0]?.sql).toContain('FROM user_memberships');
    expect(calls[0]?.params).toEqual(['user-1', '2026-06-15T00:00:00.000Z']);
  });

  it('reads the active membership overview without an allowance field', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));

    // 旧档历史 plan_key 归一为 clarity；overview 序列：SELECT user_memberships，再 ensure clarity config。
    const membership = {
      user_id: 'user-1',
      plan_key: 'fateclaw_clarity',
      status: 'active',
      current_period_start: '2026-05-30T00:00:00.000Z',
      current_period_end: '2026-07-30T00:00:00.000Z',
      created_at: '2026-05-30T00:00:00.000Z',
    };
    const { calls } = createMockPool([
      [membership],
      [
        {
          id: 'fateclaw_clarity',
          enabled: true,
          monthly_price_coins: 30,
        },
      ],
    ]);

    const overview = await getMembershipOverview('user-1');
    expect(overview).toMatchObject({
      active: true,
      membership: { plan_key: 'fateclaw_clarity' },
    });
    // 单层化后 overview 不再有 allowance 字段，且不再发起第三个（allowance）查询。
    expect(overview).not.toHaveProperty('allowance');
    expect(calls).toHaveLength(2);
  });

  it('reads batch membership overviews for a single clarity tier', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));

    const membership = {
      user_id: 'user-1',
      plan_key: 'fateclaw_clarity',
      status: 'active',
      current_period_start: '2026-05-30T00:00:00.000Z',
      current_period_end: '2026-06-30T00:00:00.000Z',
      created_at: '2026-05-30T00:00:00.000Z',
      updated_at: '2026-05-30T00:00:00.000Z',
    };
    const config = {
      id: 'fateclaw_clarity',
      enabled: true,
      monthly_price_coins: 30,
    };
    // 单层化后 getMembershipPlanConfigs 只 ensure 在售档（clarity）一次，
    // 且不再有 allowance 查询：批量概览序列收敛为 config(1) + SELECT user_memberships(1)。
    const { calls } = createMockPool([[config], [membership]]);

    const overviews = await getMembershipOverviewsByUserIds(['user-1']);

    const overview = overviews.get('user-1');
    expect(overview).toMatchObject({
      active: true,
      membership: { plan_key: 'fateclaw_clarity' },
    });
    expect(overview).not.toHaveProperty('allowance');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.sql).toContain('user_id = ANY($1::text[])');
    expect(calls[1]?.params).toEqual([['user-1']]);
  });
});
