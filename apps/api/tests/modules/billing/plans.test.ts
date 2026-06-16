import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetBillingRequestReservationByRequestId,
  mockGetMembershipOverview,
  mockGetUserById,
  mockReserveUserBalanceCoins,
  mockSettleUserModelChargeCoins,
} = vi.hoisted(() => ({
  mockGetBillingRequestReservationByRequestId: vi.fn(),
  mockGetMembershipOverview: vi.fn(),
  mockGetUserById: vi.fn(),
  mockReserveUserBalanceCoins: vi.fn(),
  mockSettleUserModelChargeCoins: vi.fn(),
}));

vi.mock('../../../src/infrastructure/db.js', () => ({
  getBillingRequestReservationByRequestId:
    mockGetBillingRequestReservationByRequestId,
  getMembershipOverview: mockGetMembershipOverview,
  getMonthlyModelChargeCoins: vi.fn(),
  getUserById: mockGetUserById,
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
  getMembershipBillingSummary,
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
    mockReserveUserBalanceCoins.mockResolvedValue({
      reservedCoins: 0,
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
      }),
    );
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

  it('reports personal allowance reset instead of membership expiration', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));

    mockGetMembershipOverview.mockResolvedValue({
      config: {
        enabled: true,
        monthly_price_coins: 30,
        monthly_allowance_units: 3000000,
      },
      membership: {
        plan_key: 'fateclaw_plus',
        current_period_start: '2026-06-30T00:00:00.000Z',
        current_period_end: '2026-07-30T00:00:00.000Z',
        created_at: '2026-05-30T00:00:00.000Z',
      },
      allowance: {
        period_end: '2026-06-30T00:00:00.000Z',
        allowance_units: 3000000,
        used_units: 1500000,
      },
      active: true,
    });

    await expect(getMembershipBillingSummary('user-1')).resolves.toMatchObject({
      currentPeriodEnd: '2026-07-30T00:00:00.000Z',
      allowanceResetAt: '2026-06-30T00:00:00.000Z',
      allowanceUsedRatio: 0.5,
    });
  });

  it('falls back to next personal reset when current allowance row has not been created yet', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));

    mockGetMembershipOverview.mockResolvedValue({
      config: {
        enabled: true,
        monthly_price_coins: 30,
        monthly_allowance_units: 3000000,
      },
      membership: {
        plan_key: 'fateclaw_plus',
        current_period_start: '2026-06-30T00:00:00.000Z',
        current_period_end: '2026-07-30T00:00:00.000Z',
        created_at: '2026-05-30T00:00:00.000Z',
      },
      allowance: null,
      active: true,
    });

    await expect(getMembershipBillingSummary('user-1')).resolves.toMatchObject({
      currentPeriodEnd: '2026-07-30T00:00:00.000Z',
      allowanceResetAt: '2026-06-30T00:00:00.000Z',
      allowanceUsedRatio: 0,
    });
  });
});
