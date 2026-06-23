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
  reserveBillingForRequest,
  settleBillingReservation,
  settleBillingReservationDetailed,
} from '../../../src/modules/billing/plans.js';
import { logger } from '../../../src/infrastructure/logger.js';

describe('metered billing plans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserById.mockResolvedValue({
      id: 'user-1',
      purchased_coins: 0,
      bonus_coins: 0,
      reserved_coins: 0,
    });
    // 模拟原子冻结:回显本次冻结的预估额,使返回的 reservedCoins 等于实际冻结额。
    mockReserveUserBalanceCoins.mockImplementation(
      async ({ amountCoins }: { amountCoins: number }) => ({
        reservedCoins: amountCoins,
      }),
    );
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

  it('freezes an estimated reserve for metered requests', async () => {
    // 估算 = 32000 输入 * 3/百万 + 8000 输出 * 8/百万 = 0.096 + 0.064 = 0.16
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
          maxOutputTokens: 8000,
        } as never,
      }),
    ).resolves.toMatchObject({
      requestId: 'request-1',
      reservedCoins: 0.16,
    });

    expect(mockReserveUserBalanceCoins).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        amountCoins: 0.16,
        requestId: 'request-1',
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
      // 该 runtime 未带单价,估算退化为最小冻结额 0.01。
      reservedCoins: 0.01,
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
      undefined,
    );
  });

  it('applies the minimum charge when real usage rounds below one cent', async () => {
    await expect(
      settleBillingReservation({
        requestId: 'request-1',
        runtime: {
          billingMode: 'metered',
          inputTokenPricePerMillionCoins: 3,
          outputTokenPricePerMillionCoins: 8,
        } as never,
        promptTokens: 1,
        completionTokens: 0,
      }),
    ).resolves.toBe(1);

    // 1 token * 3/百万 = 0.000003 → 取整为 0 → 设最小计费 0.01。
    expect(mockSettleUserModelChargeCoins).toHaveBeenCalledWith(
      'request-1',
      1,
      0.01,
      undefined,
    );
  });

  it('falls back to the frozen estimate when a successful turn reports no usage', async () => {
    mockGetBillingRequestReservationByRequestId.mockResolvedValueOnce({
      request_id: 'request-1',
      reserved_coins: 0.5,
      hold_state: 'held',
      charge_state: 'pending',
    });

    await expect(
      settleBillingReservation({
        requestId: 'request-1',
        runtime: {
          billingMode: 'metered',
          inputTokenPricePerMillionCoins: 3,
          outputTokenPricePerMillionCoins: 8,
        } as never,
        promptTokens: 0,
        completionTokens: 0,
        chargeReserveOnMissingUsage: true,
      }),
    ).resolves.toBe(1);

    // 成功但 0 usage → 按预冻结额 0.5 入账,带专属备注。
    expect(mockSettleUserModelChargeCoins).toHaveBeenCalledWith(
      'request-1',
      0,
      0.5,
      '真实用量缺失,按预冻结额入账',
    );
  });

  it('does not back-charge a failed turn that reports no usage', async () => {
    mockGetBillingRequestReservationByRequestId.mockResolvedValueOnce({
      request_id: 'request-1',
      reserved_coins: 0.5,
      hold_state: 'held',
      charge_state: 'pending',
    });

    await settleBillingReservation({
      requestId: 'request-1',
      runtime: {
        billingMode: 'metered',
        inputTokenPricePerMillionCoins: 3,
        outputTokenPricePerMillionCoins: 8,
      } as never,
      promptTokens: 0,
      completionTokens: 0,
      chargeReserveOnMissingUsage: false,
    });

    // 失败 turn 的 0 usage 视为真正零消耗,按 0 结算(仍会释放冻结/置 charged)。
    expect(mockSettleUserModelChargeCoins).toHaveBeenCalledWith(
      'request-1',
      0,
      0,
      undefined,
    );
  });

  it('reconstructs runtime from the reservation when no runtime is passed (pending lost)', async () => {
    // pending 缺失(进程重启/崩溃丢内存):不传 runtime,从预留 metadata 重建单价完成结算。
    mockGetBillingRequestReservationByRequestId.mockResolvedValueOnce({
      request_id: 'request-1',
      reserved_coins: 0.5,
      hold_state: 'held',
      charge_state: 'pending',
      model_config_id: 'model-1',
      metadata: {
        billingMode: 'metered',
        source: 'official',
        modelConfigId: 'model-1',
        inputTokenPricePerMillionCoins: 3,
        outputTokenPricePerMillionCoins: 8,
      },
    });

    const result = await settleBillingReservationDetailed({
      requestId: 'request-1',
      runtime: null,
      promptTokens: 100_000,
      completionTokens: 41_873,
    });

    // 重建出 metered runtime → 按重建单价结算(与传入 runtime 时一致:0.63)。
    expect(result).toMatchObject({ metered: true });
    expect(mockSettleUserModelChargeCoins).toHaveBeenCalledWith(
      'request-1',
      141_873,
      0.63,
      undefined,
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
      metered: false,
    });
    // BYOK（自带 key）走早返回，既不查待结算记录，也不实际扣费。
    expect(mockGetBillingRequestReservationByRequestId).not.toHaveBeenCalled();
    expect(mockSettleUserModelChargeCoins).not.toHaveBeenCalled();
  });
});
