import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSubscribeCurrentUserMembership } = vi.hoisted(() => ({
  mockSubscribeCurrentUserMembership: vi.fn(),
}));

vi.mock('../../../src/modules/billing/billing-service.js', () => ({
  getBillingDailyUsage: vi.fn(),
  getBillingOverview: vi.fn(),
  getBillingTransactions: vi.fn(),
  getBillingUsage: vi.fn(),
  resetBillingScope: vi.fn(),
  subscribeCurrentUserMembership: mockSubscribeCurrentUserMembership,
}));

vi.mock('../../../src/modules/billing/recharge-service.js', () => ({
  createRechargeOrderForUser: vi.fn(),
  getRechargeStatsForUser: vi.fn(),
  handleRechargeNotification: vi.fn(),
  listRechargeOrdersForUser: vi.fn(),
  syncRechargeOrderForUser: vi.fn(),
}));

vi.mock('../../../src/interfaces/http/payment-callback-urls.js', () => ({
  resolvePaymentCallbackUrls: vi.fn(() => ({
    notify_url: 'https://app.example.test/api/billing/recharge/notify',
    return_url: 'https://app.example.test/wallet/recharge/result',
  })),
}));

import { billingRoutes } from '../../../src/interfaces/http/billing-routes.js';
import { subscribeCurrentUserMembership } from '../../../src/modules/billing/billing-service.js';

describe('billingRoutes membership plan boundary', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSubscribeCurrentUserMembership.mockResolvedValue({
      ok: true,
      data: { success: true },
    });
    app = Fastify({ logger: false });
    app.decorateRequest('requireAuth', async () => undefined);
    app.addHook('onRequest', async (request) => {
      request.user = { userId: 'user-1' } as never;
    });
    await app.register(billingRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects legacy membership plan keys at the billing HTTP boundary', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/membership/subscribe',
      payload: {
        plan_key: 'fateclaw_plus',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(subscribeCurrentUserMembership).not.toHaveBeenCalled();
  });

  it('accepts current membership plan keys', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/membership/subscribe',
      payload: {
        plan_key: 'fateclaw_clarity',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(subscribeCurrentUserMembership).toHaveBeenCalledWith(
      'user-1',
      'fateclaw_clarity',
    );
  });
});
