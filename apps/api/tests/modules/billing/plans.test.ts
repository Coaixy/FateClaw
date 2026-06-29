import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetBillingRequestReservationByRequestId,
  mockGetMembershipOverview,
  mockGetUserById,
  mockReserveUserBalanceCoins,
  mockSettleUserModelChargeCoins,
  mockExpireUserBonusBalanceBefore,
} = vi.hoisted(() => ({
  mockGetBillingRequestReservationByRequestId: vi.fn(),
  mockGetMembershipOverview: vi.fn(),
  mockGetUserById: vi.fn(),
  mockReserveUserBalanceCoins: vi.fn(),
  mockSettleUserModelChargeCoins: vi.fn(),
  mockExpireUserBonusBalanceBefore: vi.fn(),
}));

vi.mock('../../../src/infrastructure/db.js', () => ({
  getBillingRequestReservationByRequestId:
    mockGetBillingRequestReservationByRequestId,
  getMembershipOverview: mockGetMembershipOverview,
  getMonthlyModelChargeCoins: vi.fn(),
  getUserById: mockGetUserById,
  expireUserBonusBalanceBefore: mockExpireUserBonusBalanceBefore,
  releaseUserBalanceReservation: vi.fn(),
  reserveUserBalanceCoins: mockReserveUserBalanceCoins,
  settleUserModelChargeCoins: mockSettleUserModelChargeCoins,
}));

vi.mock('../../../src/infrastructure/daily-usage.js', () => ({
  getMonthlyTokenUsage: vi.fn(),
  getMonthlyTokenUsageByUserIds: vi.fn(),
}));

vi.mock('../../../src/infrastructure/logger.js', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

import {
  applyNonMemberPricingMarkup,
  BILLING_PRICE_MISCONFIGURED_MESSAGE,
  NON_MEMBER_PRICE_MULTIPLIER,
  recoverStalePendingReservation,
  reserveBillingForRequest,
  settleBillingReservation,
  settleBillingReservationDetailed,
} from '../../../src/modules/billing/plans.js';
import { logger } from '../../../src/infrastructure/logger.js';

describe('applyNonMemberPricingMarkup（非会员专家模式加价）', () => {
  // 工厂：默认造一个 metered 官方模型快照，按 overrides 改字段；字段不全用 as never 绕类型。
  const make = (overrides: Record<string, unknown> = {}) =>
    ({
      billingMode: 'metered',
      source: 'official',
      modelConfigId: 'model-1',
      model: 'gpt-test',
      inputTokenPricePerMillionCoins: 3,
      outputTokenPricePerMillionCoins: 8,
      ...overrides,
    }) as never;

  it('会员原价：membershipActive=true 时原样返回，不加价', () => {
    const result = applyNonMemberPricingMarkup(make(), true);
    expect(result.inputTokenPricePerMillionCoins).toBe(3);
    expect(result.outputTokenPricePerMillionCoins).toBe(8);
  });

  it('非会员加价：metered 官方模型 input/output 单价均 ×系数', () => {
    const result = applyNonMemberPricingMarkup(make(), false);
    expect(result.inputTokenPricePerMillionCoins).toBe(
      3 * NON_MEMBER_PRICE_MULTIPLIER,
    );
    expect(result.outputTokenPricePerMillionCoins).toBe(
      8 * NON_MEMBER_PRICE_MULTIPLIER,
    );
  });

  it('BYOK 豁免：source=custom 即便非会员也不加价（结算恒 0）', () => {
    const result = applyNonMemberPricingMarkup(make({ source: 'custom' }), false);
    expect(result.inputTokenPricePerMillionCoins).toBe(3);
    expect(result.outputTokenPricePerMillionCoins).toBe(8);
  });

  it('非计费豁免：billingMode=none 不加价', () => {
    const result = applyNonMemberPricingMarkup(make({ billingMode: 'none' }), false);
    expect(result.inputTokenPricePerMillionCoins).toBe(3);
    expect(result.outputTokenPricePerMillionCoins).toBe(8);
  });
});

describe('metered billing plans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserById.mockResolvedValue({
      id: 'user-1',
      purchased_coins: 0,
      bonus_coins: 0,
      reserved_coins: 0,
    });
    mockReserveUserBalanceCoins.mockResolvedValue({
      reservedCoins: 0,
    });
    mockExpireUserBonusBalanceBefore.mockResolvedValue({
      expired: 0,
      totalCoinsExpired: 0,
    });
    mockGetBillingRequestReservationByRequestId.mockResolvedValue({
      request_id: 'request-1',
    });
    mockGetMembershipOverview.mockResolvedValue({
      config: {
        enabled: true,
        monthly_price_coins: 30,
        monthly_allowance_units: 3000000,
      },
      membership: null,
      allowance: null,
      active: false,
    });
    mockSettleUserModelChargeCoins.mockResolvedValue({
      actualChargeCoins: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records metered requests without reserving balance', async () => {
    await expect(
      reserveBillingForRequest({
        userId: 'user-1',
        requestId: 'request-1',
        runtime: {
          billingMode: 'metered',
          source: 'official',
          modelConfigId: 'model-1',
          model: 'gpt-test',
          inputTokenPricePerMillionCoins: 3,
          outputTokenPricePerMillionCoins: 8,
        } as never,
      }),
    ).resolves.toMatchObject({
      requestId: 'request-1',
      reservedCoins: 0,
    });

    expect(mockReserveUserBalanceCoins).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        amountCoins: 0,
        requestId: 'request-1',
        // 下单时价格写入预留 metadata，供 sweeper 兜底结算按当时价重算。
        metadata: expect.objectContaining({
          inputTokenPricePerMillionCoins: 3,
          outputTokenPricePerMillionCoins: 8,
        }),
      }),
    );
  });

  it('uses prepared entitlement wallet without syncing bonus grants again', async () => {
    await expect(
      reserveBillingForRequest({
        userId: 'user-1',
        requestId: 'request-1',
        runtime: {
          billingMode: 'metered',
          source: 'official',
          modelConfigId: 'model-1',
          model: 'gpt-test',
          inputTokenPricePerMillionCoins: 3,
          outputTokenPricePerMillionCoins: 8,
        } as never,
        entitlementSnapshot: {
          planKey: null,
          membershipActive: false,
          availableCoins: 10,
          wallet: {
            purchased_coins: 10,
            bonus_coins: 0,
            reserved_coins: 0,
            inArrears: false,
          },
        },
      }),
    ).resolves.toMatchObject({
      requestId: 'request-1',
      reservedCoins: 0,
    });

    expect(mockExpireUserBonusBalanceBefore).not.toHaveBeenCalled();
    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockReserveUserBalanceCoins).toHaveBeenCalledOnce();
  });

  it('blocks new metered requests when the user is already in arrears', async () => {
    mockGetUserById.mockResolvedValue({
      id: 'user-1',
      purchased_coins: -1,
      bonus_coins: 0,
      reserved_coins: 0,
    });

    await expect(
      reserveBillingForRequest({
        userId: 'user-1',
        requestId: 'request-1',
        runtime: {
          billingMode: 'metered',
        } as never,
      }),
    ).rejects.toThrow('积分已欠费，请补充积分后继续使用');
    expect(mockReserveUserBalanceCoins).not.toHaveBeenCalled();
  });

  it('passes prompt tokens with cache extras priced as normal input tokens to settlement', async () => {
    await expect(
      settleBillingReservation({
        requestId: 'request-1',
        runtime: {
          billingMode: 'metered',
          inputTokenPricePerMillionCoins: 3,
          outputTokenPricePerMillionCoins: 8,
        } as never,
        promptTokens: 100_000,
        completionTokens: 41_873,
      }),
    ).resolves.toBe(1);

    expect(mockSettleUserModelChargeCoins).toHaveBeenCalledWith(
      'request-1',
      141_873,
      0.63,
    );
  });

  it('marks metered settlement as missing when reservation is absent', async () => {
    mockGetBillingRequestReservationByRequestId.mockResolvedValueOnce(
      undefined,
    );

    await expect(
      settleBillingReservationDetailed({
        requestId: 'request-missing',
        runtime: {
          billingMode: 'metered',
          source: 'official',
          modelConfigId: 'model-1',
          inputTokenPricePerMillionCoins: 3,
          outputTokenPricePerMillionCoins: 8,
        } as never,
        promptTokens: 1,
        completionTokens: 1,
      }),
    ).resolves.toMatchObject({
      actualChargeCoins: 0,
      missingReservation: true,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-missing',
        modelConfigId: 'model-1',
      }),
      '计费结算缺失待结算记录',
    );
    expect(mockSettleUserModelChargeCoins).not.toHaveBeenCalled();
  });

  it('rejects metered requests whose input and output prices are both <= 0', async () => {
    await expect(
      reserveBillingForRequest({
        userId: 'user-1',
        requestId: 'request-1',
        runtime: {
          billingMode: 'metered',
          source: 'official',
          modelConfigId: 'model-1',
          model: 'gpt-test',
          inputTokenPricePerMillionCoins: 0,
          outputTokenPricePerMillionCoins: 0,
        } as never,
      }),
    ).rejects.toThrow(BILLING_PRICE_MISCONFIGURED_MESSAGE);
    // 误配（全免费）直接拒绝起请求，不落预留。
    expect(mockReserveUserBalanceCoins).not.toHaveBeenCalled();
  });

  it('warns but still reserves when only one price is <= 0', async () => {
    await expect(
      reserveBillingForRequest({
        userId: 'user-1',
        requestId: 'request-1',
        runtime: {
          billingMode: 'metered',
          source: 'official',
          modelConfigId: 'model-1',
          model: 'gpt-test',
          inputTokenPricePerMillionCoins: 3,
          outputTokenPricePerMillionCoins: 0,
        } as never,
      }),
    ).resolves.toMatchObject({ requestId: 'request-1' });
    // 仅其一 ≤0：告警留痕但放行（避免误伤可能的特殊计价模型）。
    expect(logger.warn).toHaveBeenCalled();
    expect(mockReserveUserBalanceCoins).toHaveBeenCalledOnce();
  });

  it('recovers a stale pending reservation using prices recorded in metadata', async () => {
    mockGetBillingRequestReservationByRequestId.mockResolvedValueOnce({
      request_id: 'request-stale',
      charge_state: 'pending',
      metadata: {
        billingMode: 'metered',
        source: 'official',
        inputTokenPricePerMillionCoins: 3,
        outputTokenPricePerMillionCoins: 8,
      },
    });
    mockSettleUserModelChargeCoins.mockResolvedValueOnce({
      actualChargeCoins: 0.63,
      rawChargeCoins: 0.63,
    });

    const result = await recoverStalePendingReservation({
      requestId: 'request-stale',
      promptTokens: 100_000,
      completionTokens: 41_873,
    });

    expect(result).toMatchObject({ actualChargeCoins: 0.63 });
    // 按"当时价"重算：100000*3/1e6 + 41873*8/1e6 = 0.3 + 0.334984 → 0.63（四舍五入到分）。
    expect(mockSettleUserModelChargeCoins).toHaveBeenCalledWith(
      'request-stale',
      141_873,
      0.63,
    );
  });

  it('closes a stale BYOK reservation at zero charge', async () => {
    mockGetBillingRequestReservationByRequestId.mockResolvedValueOnce({
      request_id: 'request-byok-stale',
      charge_state: 'pending',
      metadata: { billingMode: 'metered', source: 'custom' },
    });
    mockSettleUserModelChargeCoins.mockResolvedValueOnce({
      actualChargeCoins: 0,
      rawChargeCoins: 0,
    });

    const result = await recoverStalePendingReservation({
      requestId: 'request-byok-stale',
      promptTokens: 1000,
      completionTokens: 500,
    });

    expect(result).toEqual({ actualChargeCoins: 0, rawChargeCoins: 0 });
    // BYOK 成本恒 0，以 0 关账收尾。
    expect(mockSettleUserModelChargeCoins).toHaveBeenCalledWith(
      'request-byok-stale',
      0,
      0,
    );
  });

  it('skips an already-charged reservation', async () => {
    mockGetBillingRequestReservationByRequestId.mockResolvedValueOnce({
      request_id: 'request-charged',
      charge_state: 'charged',
      metadata: { billingMode: 'metered', source: 'official' },
    });

    const result = await recoverStalePendingReservation({
      requestId: 'request-charged',
      promptTokens: 100,
      completionTokens: 100,
    });

    expect(result).toBeNull();
    expect(mockSettleUserModelChargeCoins).not.toHaveBeenCalled();
  });

  it('returns zero charge for BYOK custom-source runtime without settling', async () => {
    const result = await settleBillingReservationDetailed({
      requestId: 'request-byok',
      runtime: {
        billingMode: 'metered',
        source: 'custom',
        modelConfigId: 'custom:user-1',
        inputTokenPricePerMillionCoins: 3,
        outputTokenPricePerMillionCoins: 8,
      } as never,
      promptTokens: 1000,
      completionTokens: 500,
    });

    expect(result).toEqual({
      actualChargeCoins: 0,
      rawChargeCoins: 0,
    });
    // BYOK（自带 key）走早返回，既不查待结算记录，也不实际扣费。
    expect(mockGetBillingRequestReservationByRequestId).not.toHaveBeenCalled();
    expect(mockSettleUserModelChargeCoins).not.toHaveBeenCalled();
  });
});
