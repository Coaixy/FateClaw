import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  RechargeOrderRow,
  RechargePaymentConfigRow,
} from '../../infrastructure/db.js';

const {
  mockCreateEpayPayment,
  mockGetRechargeOrderByTradeId,
  mockGetRechargePaymentConfig,
  mockGetUserById,
  mockInsertRechargeOrder,
  mockMarkRechargeOrderFailed,
  mockMarkRechargeOrderPaymentCreated,
  mockQueryEpayOrder,
  mockSettleRechargeOrderPaid,
  mockVerifyEpayNotification,
} = vi.hoisted(() => ({
  mockCreateEpayPayment: vi.fn(),
  mockGetRechargeOrderByTradeId: vi.fn(),
  mockGetRechargePaymentConfig: vi.fn(),
  mockGetUserById: vi.fn(),
  mockInsertRechargeOrder: vi.fn(),
  mockMarkRechargeOrderFailed: vi.fn(),
  mockMarkRechargeOrderPaymentCreated: vi.fn(),
  mockQueryEpayOrder: vi.fn(),
  mockSettleRechargeOrderPaid: vi.fn(),
  mockVerifyEpayNotification: vi.fn(),
}));

vi.mock('../../infrastructure/db.js', () => ({
  getRechargeOrderByTradeId: mockGetRechargeOrderByTradeId,
  getRechargeOrderByTradeIdForUser: vi.fn(),
  getRechargePaymentConfig: mockGetRechargePaymentConfig,
  getRechargeStatsByUserId: vi.fn(),
  getUserById: mockGetUserById,
  insertRechargeOrder: mockInsertRechargeOrder,
  listRechargeOrdersByUserId: vi.fn(),
  markRechargeOrderFailed: mockMarkRechargeOrderFailed,
  markRechargeOrderPaymentCreated: mockMarkRechargeOrderPaymentCreated,
  settleRechargeOrderPaid: mockSettleRechargeOrderPaid,
  updateRechargePaymentConfig: vi.fn(),
}));

vi.mock('./epay-client.js', async () => {
  const actual =
    await vi.importActual<typeof import('./epay-client.js')>(
      './epay-client.js',
    );
  return {
    ...actual,
    createEpayPayment: mockCreateEpayPayment,
    queryEpayOrder: mockQueryEpayOrder,
    verifyEpayNotification: mockVerifyEpayNotification,
  };
});

import {
  createRechargeOrderForUser,
  handleRechargeNotification,
} from './recharge-service.js';

function paymentConfig(
  overrides: Partial<RechargePaymentConfigRow> = {},
): RechargePaymentConfigRow {
  return {
    id: 'default',
    enabled: true,
    min_coins: '1.00',
    max_coins: '100.00',
    epay_url_prefix: 'https://pay.example.test',
    epay_platform_id: 1001,
    epay_merchant_private_key: 'private-key',
    epay_platform_public_key: 'public-key',
    epay_merchant_key: 'query-key',
    notify_url: '',
    return_url: '',
    updated_at: '2026-06-05T00:00:00.000Z',
    ...overrides,
  };
}

function rechargeOrder(
  overrides: Partial<RechargeOrderRow> = {},
): RechargeOrderRow {
  return {
    id: 'ro-1',
    user_id: 'user-1',
    trade_id: 'trade-1',
    provider: 'epay',
    provider_trade_id: null,
    pay_type: 'alipay',
    amount_coins: 10,
    pay_url: null,
    status: 'pending',
    paid_at: null,
    notified_at: null,
    metadata: {},
    created_at: '2026-06-05T00:00:00.000Z',
    updated_at: '2026-06-05T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRechargePaymentConfig.mockResolvedValue(paymentConfig());
  mockGetRechargeOrderByTradeId.mockResolvedValue(rechargeOrder());
  mockSettleRechargeOrderPaid.mockResolvedValue(
    rechargeOrder({
      status: 'paid',
      paid_at: '2026-06-05T00:01:00.000Z',
      notified_at: '2026-06-05T00:01:00.000Z',
    }),
  );
  mockVerifyEpayNotification.mockReturnValue(true);
});

describe('handleRechargeNotification', () => {
  it('acknowledges signed non-success notifications without settling the order', async () => {
    const result = await handleRechargeNotification({
      out_trade_no: 'trade-1',
      pid: '1001',
      money: '10.00',
      status: '0',
      sign: 'signature',
    });

    expect(result.ok).toBe(true);
    expect(mockSettleRechargeOrderPaid).not.toHaveBeenCalled();
    if (result.ok) {
      expect(result.data.status).toBe('pending');
    }
  });

  it('settles signed notifications when numeric status is the official paid value', async () => {
    const result = await handleRechargeNotification({
      out_trade_no: 'trade-1',
      pid: 1001,
      money: 10,
      status: 1,
      trade_no: 'provider-1',
      type: 'alipay',
      sign: 'signature',
    });

    expect(result.ok).toBe(true);
    expect(mockSettleRechargeOrderPaid).toHaveBeenCalledWith(
      expect.objectContaining({
        tradeId: 'trade-1',
        providerTradeId: 'provider-1',
        payType: 'alipay',
        notifyPayload: expect.objectContaining({
          status: '1',
        }),
      }),
    );
  });

  it('does not settle signed notifications without an explicit paid status', async () => {
    const result = await handleRechargeNotification({
      out_trade_no: 'trade-1',
      pid: '1001',
      money: '10.00',
      sign: 'signature',
    });

    expect(result.ok).toBe(true);
    expect(mockSettleRechargeOrderPaid).not.toHaveBeenCalled();
  });
});

describe('createRechargeOrderForUser', () => {
  it('refuses non-HTTPS epay_url_prefix before creating an external payment order', async () => {
    mockGetRechargePaymentConfig.mockResolvedValue(
      paymentConfig({
        epay_url_prefix: 'http://pay.example.test',
      }),
    );

    const result = await createRechargeOrderForUser({
      userId: 'user-1',
      amountCoins: '10.00',
      payType: 'alipay',
      clientIp: '127.0.0.1',
      callbackUrls: {
        notifyUrl: 'https://app.example.test/api/billing/recharge/notify',
        returnUrl: 'https://app.example.test/wallet',
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(503);
    }
    expect(mockInsertRechargeOrder).not.toHaveBeenCalled();
    expect(mockCreateEpayPayment).not.toHaveBeenCalled();
  });
});
