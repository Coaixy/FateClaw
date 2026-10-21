import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BENEFIT_POLICY } from '@fateclaw/contracts/model-settings';

const {
  mockRateLimitCheck,
  mockRateLimitClear,
  mockRateLimitRecordFail,
  mockFixedWindowRateLimit,
  mockListAdminIssues,
} = vi.hoisted(() => ({
  mockRateLimitCheck: vi.fn(),
  mockRateLimitClear: vi.fn(),
  mockRateLimitRecordFail: vi.fn(),
  mockFixedWindowRateLimit: vi.fn(),
  mockListAdminIssues: vi.fn(),
}));

vi.mock('#infrastructure/config', () => ({
  BILLING_RESERVATION_STALE_MS: 2_400_000,
  MANAGER_KEY: 'test-manager-key',
  USER_MANAGER_KEY: 'test-user-manager-key',
}));

vi.mock('#infrastructure/repositories/runtime-config-repository', () => ({
  getRuntimeConfig: vi.fn(),
  saveRuntimeConfig: vi.fn(),
}));
import {
  getRuntimeConfig,
  saveRuntimeConfig,
} from '#infrastructure/repositories/runtime-config-repository';

vi.mock('#interfaces/http/rate-limit', () => ({
  rateLimitCheck: mockRateLimitCheck,
  rateLimitClear: mockRateLimitClear,
  rateLimitRecordFail: mockRateLimitRecordFail,
  fixedWindowRateLimit: mockFixedWindowRateLimit,
}));

vi.mock('#modules/issues/issue-service', () => ({
  listAdminIssues: mockListAdminIssues,
  getAdminIssue: vi.fn(),
  getPublicIssue: vi.fn(),
  listPublicIssues: vi.fn(),
}));

vi.mock('#modules/announcements/announcement-service', () => ({
  getAdminAnnouncements: vi.fn(async () => ({
    items: [],
    total: 0,
    page: 1,
    page_size: 20,
  })),
  getPublicAnnouncements: vi.fn(),
  saveAnnouncement: vi.fn(),
}));

vi.mock('#modules/admin/admin-service', () => ({
  adjustUserPurchasedBalance: vi.fn(),
  cancelAdminUserMembership: vi.fn(),
  cleanupPiSessionFilesForAdmin: vi.fn(),
  createAdminUser: vi.fn(),
  deleteConversationLogsForAdminUser: vi.fn(),
  deleteUser: vi.fn(),
  getAdminGlobalStats: vi.fn(),
  getAdminRechargePaymentConfig: vi.fn(),
  getAdminStatusOverview: vi.fn(),
  getAdminUserDetail: vi.fn(),
  getBalanceGrantsByUserId: vi.fn(),
  getChatSessionsForAdmin: vi.fn(),
  getConversationLogById: vi.fn(),
  getConversationLogByRequestId: vi.fn(),
  getConversationLogSummaries: vi.fn(),
  getCustomSkillForAdmin: vi.fn(),
  getCustomSkillsForAdmin: vi.fn(),
  getMessagesForAdmin: vi.fn(),
  getSystemConfigOverview: vi.fn(),
  saveOfficialModelSettings: vi.fn(),
  getUserById: vi.fn(),
  getUserCustomSkillById: vi.fn(),
  getWalletTransactionsByUserId: vi.fn(),
  grantBonusBalance: vi.fn(),
  hasOfficialSkill: vi.fn(),
  listAdminGlobalSkills: vi.fn(),
  listSkillCommentsForAdmin: vi.fn(),
  listAdminUsersWithStats: vi.fn(),
  listBillingRequestReservations: vi.fn(),
  listBillingRequestReservationsPageForAdmin: vi.fn(),
  listRechargeOrdersForAdmin: vi.fn(),
  listWalletTransactionsForAdmin: vi.fn(),
  reconcileStaleBillingReservations: vi.fn(),
  reviewSkillCommentForAdmin: vi.fn(),
  resetAdminUserPassword: vi.fn(),
  setAdminUserMembership: vi.fn(),
  scanPiSessionOrphanFilesForAdmin: vi.fn(),
  setSkillGlobalEnabled: vi.fn(),
  setSkillCommentPinnedForAdmin: vi.fn(),
  setUserCustomSkillAdminState: vi.fn(),
  updateAdminRechargePaymentConfig: vi.fn(),
}));

vi.mock('#interfaces/http/payment-callback-urls', () => ({
  resolvePaymentCallbackUrls: vi.fn(() => ({
    notify_url: 'https://app.example.test/api/billing/recharge/notify',
    return_url: 'https://app.example.test/wallet/recharge/result',
  })),
}));

import { adminRoutes } from '#interfaces/http/admin-routes';
import {
  adjustUserPurchasedBalance,
  cancelAdminUserMembership,
  cleanupPiSessionFilesForAdmin,
  createAdminUser,
  deleteConversationLogsForAdminUser,
  deleteUser,
  getAdminGlobalStats,
  getAdminStatusOverview,
  grantBonusBalance,
  getMessagesForAdmin,
  listBillingRequestReservationsPageForAdmin,
  listRechargeOrdersForAdmin,
  listAdminUsersWithStats,
  listSkillCommentsForAdmin,
  listWalletTransactionsForAdmin,
  reviewSkillCommentForAdmin,
  resetAdminUserPassword,
  scanPiSessionOrphanFilesForAdmin,
  setAdminUserMembership,
  setSkillCommentPinnedForAdmin,
  saveOfficialModelSettings,
} from '#modules/admin/admin-service';

function skillCommentFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'comment-1',
    skill_id: 'skill-1',
    skill_name: '公开 Skill',
    user_id: 'user-1',
    user_phone: '13800000000',
    body: '评论内容',
    status: 'pending',
    pinned: false,
    reviewed_by: null,
    reviewed_at: null,
    created_at: '2026-06-12T00:00:00.000Z',
    updated_at: '2026-06-12T00:00:00.000Z',
    ...overrides,
  };
}

describe('adminRoutes authentication throttling', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockRateLimitRecordFail.mockResolvedValue(undefined);
    mockRateLimitClear.mockResolvedValue(undefined);
    mockFixedWindowRateLimit.mockResolvedValue({
      allowed: true,
      retryAfterSec: 0,
    });
    mockListAdminIssues.mockResolvedValue({
      items: [],
      hidden_ids: [],
      total: 0,
      page: 1,
      page_size: 20,
    });
    vi.mocked(getAdminGlobalStats).mockResolvedValue(
      {} as Awaited<ReturnType<typeof getAdminGlobalStats>>,
    );
    vi.mocked(getAdminStatusOverview).mockResolvedValue({
      today_messages: 12,
      registered_users: 34,
      today_total_tokens: 5600,
      processing_sessions: 2,
      token_usage_series: [],
    } as Awaited<ReturnType<typeof getAdminStatusOverview>>);
    vi.mocked(getMessagesForAdmin).mockResolvedValue({
      messages: [],
      total: 0,
    } as Awaited<ReturnType<typeof getMessagesForAdmin>>);
    vi.mocked(listAdminUsersWithStats).mockResolvedValue([]);
    vi.mocked(listSkillCommentsForAdmin).mockResolvedValue([]);
    vi.mocked(listBillingRequestReservationsPageForAdmin).mockResolvedValue({
      reservations: [],
      total: 0,
    } as Awaited<
      ReturnType<typeof listBillingRequestReservationsPageForAdmin>
    >);
    vi.mocked(listRechargeOrdersForAdmin).mockResolvedValue({
      orders: [],
      total: 0,
    } as Awaited<ReturnType<typeof listRechargeOrdersForAdmin>>);
    vi.mocked(listWalletTransactionsForAdmin).mockResolvedValue({
      transactions: [],
      total: 0,
    } as Awaited<ReturnType<typeof listWalletTransactionsForAdmin>>);

    app = Fastify({ logger: false });
    await app.register(adminRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('protects issue attribution with the existing owner key boundary', async () => {
    expect((await app.inject({ url: '/issues' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: '/issues',
          headers: { 'x-admin-key': 'test-user-manager-key' },
        })
      ).statusCode,
    ).toBe(403);
    expect(mockListAdminIssues).not.toHaveBeenCalled();
    const response = await app.inject({
      url: '/issues',
      headers: { 'x-admin-key': 'test-manager-key' },
    });
    expect(response.statusCode).toBe(200);
    expect(mockListAdminIssues).toHaveBeenCalledOnce();
  });

  it('restricts announcement reads and writes to site owners', async () => {
    const url = '/announcements';
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url,
          headers: { 'x-admin-key': 'test-user-manager-key' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `${url}/fbd24536-1376-4a5e-a5e3-d4c735f0123a`,
          headers: { 'x-admin-key': 'test-user-manager-key' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url,
          headers: { 'x-admin-key': 'test-manager-key' },
        })
      ).statusCode,
    ).toBe(200);
  });

  it.each([
    { method: 'GET' as const, url: '/about-ledger' },
    { method: 'POST' as const, url: '/about-ledger' },
    { method: 'PATCH' as const, url: '/about-ledger/:id' },
    { method: 'DELETE' as const, url: '/about-ledger/:id' },
    { method: 'POST' as const, url: '/redemption-codes/generate' },
    { method: 'GET' as const, url: '/redemption-codes' },
    { method: 'GET' as const, url: '/redemption-codes/stats' },
    { method: 'POST' as const, url: '/redemption-codes/:id/revoke' },
  ])(
    'returns 404 for the retired $method $url endpoint',
    async ({ method, url }) => {
      expect(app.hasRoute({ method, url })).toBe(false);

      const response = await app.inject({
        method,
        url: url.replace(':id', 'retired-entry'),
        headers: { 'x-admin-key': 'test-manager-key' },
      });

      expect(response.statusCode).toBe(404);
    },
  );

  it('records failed admin key attempts on non-verify endpoints', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/users',
      headers: {
        'x-admin-key': 'wrong-key',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(mockRateLimitCheck).toHaveBeenCalledTimes(1);
    expect(mockRateLimitRecordFail).toHaveBeenCalledTimes(1);
    expect(mockRateLimitClear).not.toHaveBeenCalled();
  });

  it('returns owner principal metadata from verify', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      role: 'owner',
      scopes: ['admin:*'],
      home_path: '/overview',
    });
  });

  it('returns user manager principal metadata from verify', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/verify',
      headers: {
        'x-admin-key': 'test-user-manager-key',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      role: 'user_manager',
      scopes: ['users:read', 'users:create', 'messages:read'],
      home_path: '/users',
    });
  });

  it('allows the owner key to access owner-only endpoints', async () => {
    const statsResponse = await app.inject({
      method: 'GET',
      url: '/stats',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
    });
    const statusResponse = await app.inject({
      method: 'GET',
      url: '/status',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
    });

    expect(statsResponse.statusCode).toBe(200);
    expect(statusResponse.statusCode).toBe(200);
    expect(getAdminGlobalStats).toHaveBeenCalledTimes(1);
    expect(getAdminStatusOverview).toHaveBeenCalledTimes(1);
  });

  it.each([
    { method: 'POST', url: '/announcements' },
    { method: 'PATCH', url: '/announcements/retired-announcement' },
    { method: 'DELETE', url: '/announcements/retired-announcement' },
  ] as const)(
    'returns 404 for the retired $method $url endpoint',
    async ({ method, url }) => {
      expect(
        app.hasRoute({
          method,
          url: url.includes('/retired-announcement')
            ? '/announcements/:id'
            : url,
        }),
      ).toBe(false);

      const response = await app.inject({
        method,
        url,
        headers: { 'x-admin-key': 'test-manager-key' },
      });

      expect(response.statusCode).toBe(404);
    },
  );

  it('allows the owner key to query billing ledgers with filters', async () => {
    const ordersResponse = await app.inject({
      method: 'GET',
      url: '/billing/recharge-orders?user_id=user-1&status=paid&pay_type=wechat&limit=20&offset=5',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
    });
    const transactionsResponse = await app.inject({
      method: 'GET',
      url: '/billing/wallet-transactions?user_id=user-1&kind=overage_charge&limit=30&offset=10',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
    });
    const reservationsResponse = await app.inject({
      method: 'GET',
      url: '/billing/reservations?include_total=true&user_id=user-1&hold_state=held&charge_state=pending&limit=20&offset=40',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
    });

    expect(ordersResponse.statusCode).toBe(200);
    expect(transactionsResponse.statusCode).toBe(200);
    expect(reservationsResponse.statusCode).toBe(200);
    expect(listRechargeOrdersForAdmin).toHaveBeenCalledWith({
      userId: 'user-1',
      status: 'paid',
      payType: 'wechat',
      limit: 20,
      offset: 5,
    });
    expect(listWalletTransactionsForAdmin).toHaveBeenCalledWith({
      userId: 'user-1',
      kind: 'overage_charge',
      limit: 30,
      offset: 10,
    });
    expect(listBillingRequestReservationsPageForAdmin).toHaveBeenCalledWith({
      userId: 'user-1',
      holdState: 'held',
      chargeState: 'pending',
      limit: 20,
      offset: 40,
    });
  });

  it('allows the user manager key to access user and message endpoints', async () => {
    const usersResponse = await app.inject({
      method: 'GET',
      url: '/users',
      headers: {
        'x-admin-key': 'test-user-manager-key',
      },
    });
    const messagesResponse = await app.inject({
      method: 'GET',
      url: '/messages',
      headers: {
        'x-admin-key': 'test-user-manager-key',
      },
    });

    expect(usersResponse.statusCode).toBe(200);
    expect(messagesResponse.statusCode).toBe(200);
    expect(listAdminUsersWithStats).toHaveBeenCalledTimes(1);
    expect(getMessagesForAdmin).toHaveBeenCalledTimes(1);
  });

  it('allows the owner key to create admin users', async () => {
    vi.mocked(createAdminUser).mockResolvedValueOnce({
      id: 'created-admin-user',
    } as Awaited<ReturnType<typeof createAdminUser>>);

    const response = await app.inject({
      method: 'POST',
      url: '/users',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
      payload: {
        phone: '13800000001',
        password: 'password123',
        role: 'admin',
        phone_verified: true,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      success: true,
      id: 'created-admin-user',
    });
    expect(createAdminUser).toHaveBeenCalledWith({
      phone: '13800000001',
      password: 'password123',
      role: 'admin',
      phoneVerified: true,
    });
  });

  it('rejects admin user creation from the user manager key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/users',
      headers: {
        'x-admin-key': 'test-user-manager-key',
      },
      payload: {
        phone: '13800000002',
        password: 'password123',
        role: 'admin',
        phone_verified: true,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: 'user_manager 无权创建 admin 角色用户',
    });
    expect(createAdminUser).not.toHaveBeenCalled();
  });

  it('allows the user manager key to create consumer users', async () => {
    vi.mocked(createAdminUser).mockResolvedValueOnce({
      id: 'created-consumer-user',
    } as Awaited<ReturnType<typeof createAdminUser>>);

    const response = await app.inject({
      method: 'POST',
      url: '/users',
      headers: {
        'x-admin-key': 'test-user-manager-key',
      },
      payload: {
        phone: '13800000003',
        password: 'password123',
        role: 'consumer',
        phone_verified: true,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      success: true,
      id: 'created-consumer-user',
    });
    expect(createAdminUser).toHaveBeenCalledWith({
      phone: '13800000003',
      password: 'password123',
      role: 'consumer',
      phoneVerified: true,
    });
  });

  it('matches user manager scopes when admin routes are mounted with the API prefix', async () => {
    const prefixedApp = Fastify({ logger: false });
    await prefixedApp.register(adminRoutes, { prefix: '/api/admin' });
    await prefixedApp.ready();

    try {
      const response = await prefixedApp.inject({
        method: 'GET',
        url: '/api/admin/users',
        headers: {
          'x-admin-key': 'test-user-manager-key',
        },
      });

      expect(response.statusCode).toBe(200);
    } finally {
      await prefixedApp.close();
    }
  });

  it('rejects unsupported membership identities at the admin HTTP boundary', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/users/user-1/membership',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
      payload: {
        plan_key: 'unknown',
        current_period_end: '2026-07-01T00:00:00.000+08:00',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(setAdminUserMembership).not.toHaveBeenCalled();
  });

  it('blocks the user manager key from high-risk user operations', async () => {
    const grantResponse = await app.inject({
      method: 'POST',
      url: '/users/user-1/balance/grant',
      headers: {
        'x-admin-key': 'test-user-manager-key',
      },
      payload: {
        amount_coins: 1,
      },
    });
    const adjustResponse = await app.inject({
      method: 'POST',
      url: '/users/user-1/balance/adjust',
      headers: {
        'x-admin-key': 'test-user-manager-key',
      },
      payload: {
        amount_coins: 1,
      },
    });
    const passwordResponse = await app.inject({
      method: 'POST',
      url: '/users/user-1/password',
      headers: {
        'x-admin-key': 'test-user-manager-key',
      },
      payload: {
        password: 'new-password',
      },
    });
    const setMembershipResponse = await app.inject({
      method: 'POST',
      url: '/users/user-1/membership',
      headers: {
        'x-admin-key': 'test-user-manager-key',
      },
      payload: {
        plan_key: 'membership',
        current_period_end: '2026-07-01T00:00:00.000+08:00',
      },
    });
    const cancelMembershipResponse = await app.inject({
      method: 'DELETE',
      url: '/users/user-1/membership',
      headers: {
        'x-admin-key': 'test-user-manager-key',
      },
    });
    const clearLogsResponse = await app.inject({
      method: 'DELETE',
      url: '/users/user-1/logs',
      headers: {
        'x-admin-key': 'test-user-manager-key',
      },
    });
    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: '/users/user-1',
      headers: {
        'x-admin-key': 'test-user-manager-key',
      },
    });

    expect(grantResponse.statusCode).toBe(403);
    expect(adjustResponse.statusCode).toBe(403);
    expect(passwordResponse.statusCode).toBe(403);
    expect(setMembershipResponse.statusCode).toBe(403);
    expect(cancelMembershipResponse.statusCode).toBe(403);
    expect(clearLogsResponse.statusCode).toBe(403);
    expect(deleteResponse.statusCode).toBe(403);
    expect(grantBonusBalance).not.toHaveBeenCalled();
    expect(adjustUserPurchasedBalance).not.toHaveBeenCalled();
    expect(resetAdminUserPassword).not.toHaveBeenCalled();
    expect(setAdminUserMembership).not.toHaveBeenCalled();
    expect(cancelAdminUserMembership).not.toHaveBeenCalled();
    expect(deleteConversationLogsForAdminUser).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('blocks the user manager key from Pi session cleanup operations', async () => {
    const cleanupResponse = await app.inject({
      method: 'POST',
      url: '/chat-sessions/pi-sessions/cleanup',
      headers: {
        'x-admin-key': 'test-user-manager-key',
      },
      payload: {
        mode: 'inactive',
      },
    });
    const orphanScanResponse = await app.inject({
      method: 'POST',
      url: '/chat-sessions/pi-sessions/orphans/scan',
      headers: {
        'x-admin-key': 'test-user-manager-key',
      },
      payload: {
        action: 'audit',
      },
    });

    expect(cleanupResponse.statusCode).toBe(403);
    expect(orphanScanResponse.statusCode).toBe(403);
    expect(cleanupPiSessionFilesForAdmin).not.toHaveBeenCalled();
    expect(scanPiSessionOrphanFilesForAdmin).not.toHaveBeenCalled();
  });

  it('blocks the user manager key from owner-only endpoints', async () => {
    const statsResponse = await app.inject({
      method: 'GET',
      url: '/stats',
      headers: {
        'x-admin-key': 'test-user-manager-key',
      },
    });
    const logsResponse = await app.inject({
      method: 'GET',
      url: '/logs?accountId=account-1',
      headers: {
        'x-admin-key': 'test-user-manager-key',
      },
    });
    const billingResponse = await app.inject({
      method: 'GET',
      url: '/billing/recharge-orders',
      headers: {
        'x-admin-key': 'test-user-manager-key',
      },
    });
    const statusResponse = await app.inject({
      method: 'GET',
      url: '/status',
      headers: {
        'x-admin-key': 'test-user-manager-key',
      },
    });

    expect(statsResponse.statusCode).toBe(403);
    expect(logsResponse.statusCode).toBe(403);
    expect(billingResponse.statusCode).toBe(403);
    expect(statusResponse.statusCode).toBe(403);
    expect(getAdminGlobalStats).not.toHaveBeenCalled();
    expect(getAdminStatusOverview).not.toHaveBeenCalled();
    expect(listRechargeOrdersForAdmin).not.toHaveBeenCalled();
  });

  it('blocks non-verify endpoints when admin auth is rate limited', async () => {
    mockRateLimitCheck.mockResolvedValueOnce({
      allowed: false,
      retryAfterMs: 2500,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/users',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('3');
    expect(mockRateLimitRecordFail).not.toHaveBeenCalled();
    expect(mockRateLimitClear).not.toHaveBeenCalled();
  });

  it('accepts free supply without manually configured upstream quotas', async () => {
    const payload = {
      display_name: '免费模型',
      thinking_level: 'off',
      input_token_price_per_million_coins: 0,
      output_token_price_per_million_coins: 0,
      revision: 1,
      enabled: true,
      benefit_policy: DEFAULT_BENEFIT_POLICY,
      nodes: [
        {
          display_name: '免费节点',
          pi_api: 'openai-completions',
          base_url: null,
          model_name: 'synthetic-model',
          context_window_tokens: null,
          enabled: true,
          weight: 1,
        },
      ],
    };
    const response = await app.inject({
      method: 'PUT',
      url: '/system-config/benefit',
      headers: { 'x-admin-key': 'test-manager-key' },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(saveOfficialModelSettings).toHaveBeenCalledWith(
      { ...payload, actor: 'manager' },
      'benefit',
    );
  });

  it('saves mixed-model pool nodes and common pricing atomically', async () => {
    const payload = {
      display_name: '官方模型池',
      thinking_level: 'low',
      input_token_price_per_million_coins: 2,
      output_token_price_per_million_coins: 8,
      nodes: [
        {
          display_name: '供应商 A',
          pi_api: 'openai-responses',
          base_url: null,
          model_name: 'gpt-4.1',
          api_key: 'synthetic-test-api-key',
          context_window_tokens: null,
          enabled: true,
          weight: 2,
        },
        {
          display_name: '供应商 B',
          pi_api: 'anthropic-messages',
          base_url: null,
          model_name: 'synthetic-other-model',
          api_key: 'synthetic-other-key',
          context_window_tokens: 32_000,
          enabled: true,
          weight: 1,
        },
      ],
    };
    const overview = {
      model: {
        id: 'official',
        model_key: 'official',
        model_name: 'official',
        display_name: '官方模型池',
        description: '',
        context_window_tokens: 32_000,
        input_token_price_per_million_coins: 2,
        output_token_price_per_million_coins: 8,
        has_secret: true,
      },
      thinking_level: 'low' as const,
      nodes: [],
    };
    vi.mocked(saveOfficialModelSettings).mockResolvedValueOnce(overview);
    const response = await app.inject({
      method: 'PUT',
      url: '/system-config/model',
      headers: { 'x-admin-key': 'test-manager-key' },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(overview);
    expect(saveOfficialModelSettings).toHaveBeenCalledWith({
      ...payload,
      actor: 'manager',
    });
  });

  it.each([
    { thinking_level: 'unlimited' },
    { nodes: [] },
    {
      nodes: [
        {
          display_name: 'A',
          pi_api: 'openai-responses',
          base_url: null,
          model_name: 'a',
          context_window_tokens: null,
          enabled: true,
          weight: 0,
        },
      ],
    },
    {
      nodes: [
        {
          display_name: 'A',
          pi_api: 'openai-responses',
          auth_mode: 'gemini_api_key',
          base_url: null,
          model_name: 'a',
          context_window_tokens: null,
          enabled: true,
          weight: 1,
        },
      ],
    },
    {
      nodes: [
        {
          display_name: 'A',
          pi_api: 'openai-responses',
          base_url: null,
          model_name: 'a',
          context_window_tokens: 100,
          enabled: true,
          weight: 1,
        },
      ],
    },
    { model_key: 'another-model' },
    { agent_concurrency_limit: 20 },
  ])('rejects invalid or removed pool settings', async (invalid) => {
    const response = await app.inject({
      method: 'PUT',
      url: '/system-config/model',
      headers: { 'x-admin-key': 'test-manager-key' },
      payload: {
        display_name: 'Pool',
        thinking_level: 'low',
        input_token_price_per_million_coins: 2,
        output_token_price_per_million_coins: 8,
        nodes: [
          {
            display_name: 'A',
            pi_api: 'openai-responses',
            base_url: null,
            model_name: 'a',
            context_window_tokens: null,
            enabled: true,
            weight: 1,
          },
        ],
        ...invalid,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(saveOfficialModelSettings).not.toHaveBeenCalled();
  });

  it('does not allow a user manager to change the platform model', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/system-config/model',
      headers: { 'x-admin-key': 'test-user-manager-key' },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(saveOfficialModelSettings).not.toHaveBeenCalled();
  });

  it('reads and saves owner runtime configuration while rejecting restricted administrators', async () => {
    const config = {
      revision: 2,
      agent_concurrency_limit: 3,
      agent_account_concurrency: 2,
      local_agent_max_processes: 2,
      local_agent_idle_ttl_ms: 120_000,
      pi_session_health_enabled: false,
      pi_session_inactive_cleanup_days: 30,
      pi_session_orphan_grace_days: 30,
      skill_bundle_max_files: 50,
      skill_bundle_max_file_chars: 100_000,
      skill_bundle_max_total_chars: 500_000,
      skill_bundle_max_zip_bytes: 8_388_608,
      user_skill_max_count: 30,
      wechat_claw_enabled: false,
    };
    const overview = { ...config, updated_at: '2026-10-21T00:00:00.000Z' };
    vi.mocked(getRuntimeConfig).mockResolvedValue(overview);
    vi.mocked(saveRuntimeConfig).mockResolvedValue({
      ...overview,
      revision: 3,
    });
    const headers = { 'x-admin-key': 'test-manager-key' };
    const read = await app.inject({
      method: 'GET',
      url: '/system-config/runtime',
      headers,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(overview);
    const write = await app.inject({
      method: 'PUT',
      url: '/system-config/runtime',
      headers,
      payload: config,
    });
    expect(write.statusCode).toBe(200);
    expect(saveRuntimeConfig).toHaveBeenCalledWith(config, 'owner');
    const writes = vi.mocked(saveRuntimeConfig).mock.calls.length;
    for (const method of ['GET', 'PUT'] as const) {
      const restricted = await app.inject({
        method,
        url: '/system-config/runtime',
        headers: { 'x-admin-key': 'test-user-manager-key' },
        ...(method === 'PUT' ? { payload: config } : {}),
      });
      expect(restricted.statusCode).toBe(403);
    }
    expect(vi.mocked(saveRuntimeConfig).mock.calls).toHaveLength(writes);
    for (const invalid of [
      { ...config, agent_account_concurrency: 0 },
      { ...config, skill_bundle_max_total_chars: 1 },
      { ...config, wechat_claw_enabled: 'true' },
      { ...config, default_official_model_id: 'retired' },
    ]) {
      const rejected = await app.inject({
        method: 'PUT',
        url: '/system-config/runtime',
        headers,
        payload: invalid,
      });
      expect(rejected.statusCode).toBe(400);
    }
    expect(vi.mocked(saveRuntimeConfig).mock.calls).toHaveLength(writes);
  });

  it.each([
    ['PUT', '/system-config/model-billing'],
    ['POST', '/system-config/providers'],
    ['PATCH', '/system-config/providers/legacy'],
    ['DELETE', '/system-config/providers/legacy'],
  ] as const)(
    'removes the old %s %s configuration endpoint',
    async (method, url) => {
      const response = await app.inject({
        method,
        url,
        headers: { 'x-admin-key': 'test-manager-key' },
        payload: {},
      });
      expect(response.statusCode).toBe(404);
      expect(saveOfficialModelSettings).not.toHaveBeenCalled();
    },
  );

  it('scans Pi session orphan files with admin parameters', async () => {
    vi.mocked(scanPiSessionOrphanFilesForAdmin).mockResolvedValueOnce({
      success: true,
      action: 'delete',
      grace_days: 30,
      session_dir: '/tmp/pi-sessions',
      total_files: 1,
      scanned_files: 1,
      truncated: false,
      scanned_path_files: 1,
      scanned_jsonl_files: 0,
      dangling_path_files: 1,
      unmapped_jsonl_files: 0,
      unknown_files: 0,
      unsafe_path_files: 0,
      safe_deletable_files: 1,
      deleted_path_files: 1,
      deleted_jsonl_files: 0,
      skipped_recent_files: 0,
      skipped_unarchived_files: 0,
      skipped_unmapped_session_files: 0,
      samples: {
        dangling_path_files: ['session-1.path'],
        unmapped_jsonl_files: [],
        unknown_files: [],
        unsafe_path_files: [],
        safe_deletable_files: ['session-1.path'],
        skipped_recent_files: [],
        skipped_unarchived_files: [],
        skipped_unmapped_session_files: [],
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/chat-sessions/pi-sessions/orphans/scan',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
      payload: {
        action: 'delete',
        limit: 100,
        sample_limit: 5,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(scanPiSessionOrphanFilesForAdmin).toHaveBeenCalledWith({
      action: 'delete',
      limit: 100,
      sampleLimit: 5,
    });
  });

  it('rejects Pi session orphan scan outside configured ranges', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/chat-sessions/pi-sessions/orphans/scan',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
      payload: {
        action: 'audit',
        sample_limit: 101,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(scanPiSessionOrphanFilesForAdmin).not.toHaveBeenCalled();
  });

  it('lists Skill comments with review filters for owner admins', async () => {
    vi.mocked(listSkillCommentsForAdmin).mockResolvedValueOnce([
      skillCommentFixture({
        status: 'approved',
        pinned: true,
        reviewed_by: 'owner',
        reviewed_at: '2026-06-13T00:00:00.000Z',
      }),
    ] as Awaited<ReturnType<typeof listSkillCommentsForAdmin>>);

    const response = await app.inject({
      method: 'GET',
      url: '/skills/comments?status=approved&skill_id=skill-1&limit=20',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(listSkillCommentsForAdmin).toHaveBeenCalledWith({
      status: 'approved',
      skillId: 'skill-1',
      limit: 20,
    });
    expect(response.json()).toEqual({
      items: [
        expect.objectContaining({
          id: 'comment-1',
          user_phone: '13800000000',
          status: 'approved',
          pinned: true,
        }),
      ],
    });
  });

  it('approves and rejects Skill comments for owner admins', async () => {
    vi.mocked(reviewSkillCommentForAdmin).mockResolvedValueOnce(
      skillCommentFixture({
        status: 'approved',
        reviewed_by: 'owner',
        reviewed_at: '2026-06-13T00:00:00.000Z',
      }) as Awaited<ReturnType<typeof reviewSkillCommentForAdmin>>,
    );

    const response = await app.inject({
      method: 'PATCH',
      url: '/skills/comments/comment-1/review',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
      payload: {
        status: 'approved',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(reviewSkillCommentForAdmin).toHaveBeenCalledWith({
      id: 'comment-1',
      status: 'approved',
      reviewedBy: 'owner',
    });
    expect(response.json()).toEqual(
      expect.objectContaining({
        id: 'comment-1',
        status: 'approved',
      }),
    );
  });

  it('pins approved Skill comments only when repository returns a row', async () => {
    vi.mocked(setSkillCommentPinnedForAdmin).mockResolvedValueOnce(
      skillCommentFixture({
        status: 'approved',
        pinned: true,
      }) as Awaited<ReturnType<typeof setSkillCommentPinnedForAdmin>>,
    );

    const response = await app.inject({
      method: 'PATCH',
      url: '/skills/comments/comment-1/pin',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
      payload: {
        pinned: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(setSkillCommentPinnedForAdmin).toHaveBeenCalledWith(
      'comment-1',
      true,
    );
    expect(response.json()).toEqual(
      expect.objectContaining({
        id: 'comment-1',
        pinned: true,
      }),
    );
  });

  it('returns 404 when pinning a missing or unapproved Skill comment', async () => {
    // 评论不存在或未通过审核时，repository 返回 null，路由应映射为 404
    vi.mocked(setSkillCommentPinnedForAdmin).mockResolvedValueOnce(null);

    const response = await app.inject({
      method: 'PATCH',
      url: '/skills/comments/comment-1/pin',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
      payload: {
        pinned: true,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: '评论不存在或尚未通过审核' });
  });

  it('rejects invalid Skill comment review operations', async () => {
    const listResponse = await app.inject({
      method: 'GET',
      url: '/skills/comments?status=unknown',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
    });
    const reviewResponse = await app.inject({
      method: 'PATCH',
      url: '/skills/comments/comment-1/review',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
      payload: {
        status: 'pending',
      },
    });
    const pinResponse = await app.inject({
      method: 'PATCH',
      url: '/skills/comments/comment-1/pin',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
      payload: {
        pinned: 'yes',
      },
    });

    expect(listResponse.statusCode).toBe(400);
    expect(reviewResponse.statusCode).toBe(400);
    expect(pinResponse.statusCode).toBe(400);
    expect(reviewSkillCommentForAdmin).not.toHaveBeenCalled();
    expect(setSkillCommentPinnedForAdmin).not.toHaveBeenCalled();
  });
});
