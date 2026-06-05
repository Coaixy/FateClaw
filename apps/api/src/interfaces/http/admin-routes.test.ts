import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRateLimitCheck, mockRateLimitClear, mockRateLimitRecordFail } =
  vi.hoisted(() => ({
    mockRateLimitCheck: vi.fn(),
    mockRateLimitClear: vi.fn(),
    mockRateLimitRecordFail: vi.fn(),
  }));

vi.mock('../../infrastructure/config.js', () => ({
  BILLING_RESERVATION_STALE_MS: 2_400_000,
  MANAGER_KEY: 'test-manager-key',
  USER_MANAGER_KEY: 'test-user-manager-key',
}));

vi.mock('./rate-limit.js', () => ({
  rateLimitCheck: mockRateLimitCheck,
  rateLimitClear: mockRateLimitClear,
  rateLimitRecordFail: mockRateLimitRecordFail,
}));

vi.mock('../../modules/admin/admin-service.js', () => ({
  adjustUserPurchasedBalance: vi.fn(),
  cleanupPiSessionFilesForAdmin: vi.fn(),
  createAdminUser: vi.fn(),
  createOfficialModel: vi.fn(),
  createPublicFinancialLedgerEntry: vi.fn(),
  deleteConversationLogsForAdminUser: vi.fn(),
  deletePublicFinancialLedgerEntry: vi.fn(),
  deleteUser: vi.fn(),
  getAdminGlobalStats: vi.fn(),
  getAdminRechargePaymentConfig: vi.fn(),
  getAdminRewardConfig: vi.fn(),
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
  getUserById: vi.fn(),
  getUserCustomSkillById: vi.fn(),
  getWalletTransactionsByUserId: vi.fn(),
  grantBonusBalance: vi.fn(),
  hasOfficialSkill: vi.fn(),
  listAdminGlobalSkills: vi.fn(),
  listAdminUsersWithStats: vi.fn(),
  listBillingRequestReservations: vi.fn(),
  listPublicFinancialLedgerEntries: vi.fn(),
  reconcileStaleBillingReservations: vi.fn(),
  removeOfficialModel: vi.fn(),
  setSkillGlobalEnabled: vi.fn(),
  setUserCustomSkillAdminState: vi.fn(),
  updateAdminRechargePaymentConfig: vi.fn(),
  updateAdminRewardConfig: vi.fn(),
  updateModelBillingSettings: vi.fn(),
  updateOfficialModel: vi.fn(),
  updatePublicFinancialLedgerEntry: vi.fn(),
  updateRuntimeSettings: vi.fn(),
}));

vi.mock('./payment-callback-urls.js', () => ({
  resolvePaymentCallbackUrls: vi.fn(() => ({
    notify_url: 'https://app.example.test/api/billing/recharge/notify',
    return_url: 'https://app.example.test/wallet',
  })),
}));

import { adminRoutes } from './admin-routes.js';
import {
  getAdminGlobalStats,
  getMessagesForAdmin,
  listAdminUsersWithStats,
  updateRuntimeSettings,
} from '../../modules/admin/admin-service.js';

describe('adminRoutes authentication throttling', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockRateLimitRecordFail.mockResolvedValue(undefined);
    mockRateLimitClear.mockResolvedValue(undefined);
    vi.mocked(getAdminGlobalStats).mockResolvedValue(
      {} as Awaited<ReturnType<typeof getAdminGlobalStats>>,
    );
    vi.mocked(getMessagesForAdmin).mockResolvedValue({
      messages: [],
      total: 0,
    } as Awaited<ReturnType<typeof getMessagesForAdmin>>);
    vi.mocked(listAdminUsersWithStats).mockResolvedValue([]);

    app = Fastify({ logger: false });
    await app.register(adminRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

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
      home_path: '/admin/overview',
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
      scopes: ['users:*', 'messages:*'],
      home_path: '/admin/users',
    });
  });

  it('allows the owner key to access owner-only endpoints', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/stats',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(getAdminGlobalStats).toHaveBeenCalledTimes(1);
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

  it('allows the user manager key to reach high-risk user operations', async () => {
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

    expect(adjustResponse.statusCode).toBe(404);
    expect(clearLogsResponse.statusCode).toBe(404);
    expect(deleteResponse.statusCode).toBe(404);
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

    expect(statsResponse.statusCode).toBe(403);
    expect(logsResponse.statusCode).toBe(403);
    expect(getAdminGlobalStats).not.toHaveBeenCalled();
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

  it('updates runtime config with local agent process policy fields', async () => {
    vi.mocked(updateRuntimeSettings).mockResolvedValueOnce({
      agent_concurrency_limit: 1,
      local_agent_max_processes: 2,
      local_agent_idle_ttl_ms: 120_000,
      updated_at: '2026-06-05T00:00:00.000Z',
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/system-config/runtime',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
      payload: {
        agent_concurrency_limit: 1,
        local_agent_max_processes: 2,
        local_agent_idle_ttl_ms: 120_000,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateRuntimeSettings).toHaveBeenCalledWith({
      agentConcurrencyLimit: 1,
      localAgentMaxProcesses: 2,
      localAgentIdleTtlMs: 120_000,
      actor: 'manager',
    });
  });

  it('keeps runtime config update compatible with old clients', async () => {
    vi.mocked(updateRuntimeSettings).mockResolvedValueOnce({
      agent_concurrency_limit: 3,
      local_agent_max_processes: 4,
      local_agent_idle_ttl_ms: 600_000,
      updated_at: '2026-06-05T00:00:00.000Z',
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/system-config/runtime',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
      payload: {
        agent_concurrency_limit: 3,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateRuntimeSettings).toHaveBeenCalledWith({
      agentConcurrencyLimit: 3,
      localAgentMaxProcesses: undefined,
      localAgentIdleTtlMs: undefined,
      actor: 'manager',
    });
  });

  it('rejects runtime config outside local agent policy ranges', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/system-config/runtime',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
      payload: {
        agent_concurrency_limit: 1,
        local_agent_max_processes: 2,
        local_agent_idle_ttl_ms: 29_999,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(updateRuntimeSettings).not.toHaveBeenCalled();
  });
});
