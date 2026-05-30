import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetBillingRequestReservationByRequestId,
  mockGetUserById,
  mockReserveUserBalanceCoins,
  mockSettleUserModelChargeCoins,
} = vi.hoisted(() => ({
  mockGetBillingRequestReservationByRequestId: vi.fn(),
  mockGetUserById: vi.fn(),
  mockReserveUserBalanceCoins: vi.fn(),
  mockSettleUserModelChargeCoins: vi.fn(),
}));

vi.mock('../../infrastructure/db.js', () => ({
  getBillingRequestReservationByRequestId:
    mockGetBillingRequestReservationByRequestId,
  getMonthlyModelChargeCoins: vi.fn(),
  getUserById: mockGetUserById,
  releaseUserBalanceReservation: vi.fn(),
  reserveUserBalanceCoins: mockReserveUserBalanceCoins,
  settleUserModelChargeCoins: mockSettleUserModelChargeCoins,
}));

vi.mock('../../infrastructure/daily-usage.js', () => ({
  getMonthlyTokenUsage: vi.fn(),
}));

import {
  reserveBillingForRequest,
  settleBillingReservation,
} from './plans.js';

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
    mockSettleUserModelChargeCoins.mockResolvedValue({
      actualChargeCoins: 1,
    });
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
    ).rejects.toThrow('余额已欠费，请充值后继续使用');
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
});
