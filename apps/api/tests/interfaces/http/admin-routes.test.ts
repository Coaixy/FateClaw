import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRateLimitCheck, mockRateLimitClear, mockRateLimitRecordFail } =
  vi.hoisted(() => ({
    mockRateLimitCheck: vi.fn(),
    mockRateLimitClear: vi.fn(),
    mockRateLimitRecordFail: vi.fn(),
  }));

vi.mock('../../../src/infrastructure/config.js', () => ({
  BILLING_RESERVATION_STALE_MS: 2_400_000,
  MANAGER_KEY: 'test-manager-key',
  USER_MANAGER_KEY: 'test-user-manager-key',
}));

vi.mock('../../../src/interfaces/http/rate-limit.js', () => ({
  rateLimitCheck: mockRateLimitCheck,
  rateLimitClear: mockRateLimitClear,
  rateLimitRecordFail: mockRateLimitRecordFail,
}));

vi.mock('../../../src/modules/admin/admin-service.js', () => ({
  adjustUserPurchasedBalance: vi.fn(),
  cleanupPiSessionFilesForAdmin: vi.fn(),
  createAdminUser: vi.fn(),
  createAnnouncement: vi.fn(),
  createOfficialModel: vi.fn(),
  createPublicFinancialLedgerEntry: vi.fn(),
  deleteConversationLogsForAdminUser: vi.fn(),
  deleteDraftAnnouncement: vi.fn(),
  deletePublicFinancialLedgerEntry: vi.fn(),
  deleteUser: vi.fn(),
  getAdminGlobalStats: vi.fn(),
  getAdminAnnouncementById: vi.fn(),
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
  listAdminAnnouncements: vi.fn(),
  listAdminSkillBundleSummaries: vi.fn(),
  listAdminUsersWithStats: vi.fn(),
  listBillingRequestReservations: vi.fn(),
  listBillingRequestReservationsPageForAdmin: vi.fn(),
  listRechargeOrdersForAdmin: vi.fn(),
  listPublicFinancialLedgerEntries: vi.fn(),
  listWalletTransactionsForAdmin: vi.fn(),
  listSimpleWorkflowPresets: vi.fn(),
  reconcileStaleBillingReservations: vi.fn(),
  removeOfficialModel: vi.fn(),
  scanPiSessionOrphanFilesForAdmin: vi.fn(),
  setSkillGlobalEnabled: vi.fn(),
  setUserCustomSkillAdminState: vi.fn(),
  updateAdminRechargePaymentConfig: vi.fn(),
  updateAdminRewardConfig: vi.fn(),
  updateAnnouncement: vi.fn(),
  updateModelBillingSettings: vi.fn(),
  updateOfficialModel: vi.fn(),
  updatePublicFinancialLedgerEntry: vi.fn(),
  updateRuntimeSettings: vi.fn(),
  updateSimpleWorkflowPreset: vi.fn(),
}));

vi.mock('../../../src/interfaces/http/payment-callback-urls.js', () => ({
  resolvePaymentCallbackUrls: vi.fn(() => ({
    notify_url: 'https://app.example.test/api/billing/recharge/notify',
    return_url: 'https://app.example.test/wallet/recharge/result',
  })),
}));

import { adminRoutes } from '../../../src/interfaces/http/admin-routes.js';
import {
  adjustUserPurchasedBalance,
  cleanupPiSessionFilesForAdmin,
  createAnnouncement,
  deleteDraftAnnouncement,
  deleteConversationLogsForAdminUser,
  deleteUser,
  getAdminAnnouncementById,
  getAdminGlobalStats,
  grantBonusBalance,
  getMessagesForAdmin,
  listAdminAnnouncements,
  listBillingRequestReservationsPageForAdmin,
  listRechargeOrdersForAdmin,
  listAdminSkillBundleSummaries,
  listAdminUsersWithStats,
  listWalletTransactionsForAdmin,
  scanPiSessionOrphanFilesForAdmin,
  updateAnnouncement,
  updateSimpleWorkflowPreset,
  updateRuntimeSettings,
} from '../../../src/modules/admin/admin-service.js';

function announcementFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'announcement-1',
    slug: 'maintenance',
    title: '维护公告',
    summary: '今晚维护',
    body_markdown: '今晚 23:00 维护',
    status: 'published',
    priority: 10,
    starts_at: null,
    ends_at: null,
    cta_label: null,
    cta_href: null,
    published_at: '2026-06-12T00:00:00.000Z',
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
    vi.mocked(getAdminGlobalStats).mockResolvedValue(
      {} as Awaited<ReturnType<typeof getAdminGlobalStats>>,
    );
    vi.mocked(getMessagesForAdmin).mockResolvedValue({
      messages: [],
      total: 0,
    } as Awaited<ReturnType<typeof getMessagesForAdmin>>);
    vi.mocked(listAdminAnnouncements).mockResolvedValue([]);
    vi.mocked(listAdminUsersWithStats).mockResolvedValue([]);
    vi.mocked(listAdminSkillBundleSummaries).mockResolvedValue([]);
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
      scopes: ['users:read', 'users:create', 'messages:read'],
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

  it('allows the owner key to manage announcements', async () => {
    vi.mocked(createAnnouncement).mockResolvedValueOnce(
      announcementFixture() as Awaited<ReturnType<typeof createAnnouncement>>,
    );

    const listResponse = await app.inject({
      method: 'GET',
      url: '/announcements',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
    });
    const createResponse = await app.inject({
      method: 'POST',
      url: '/announcements',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
      payload: {
        title: '维护公告',
        summary: '今晚维护',
        body_markdown: '今晚 23:00 维护',
        status: 'published',
        priority: 10,
        cta_label: '查看详情',
        cta_href: '/announcements/maintenance',
      },
    });

    expect(listResponse.statusCode).toBe(200);
    expect(createResponse.statusCode).toBe(201);
    expect(listAdminAnnouncements).toHaveBeenCalledTimes(1);
    expect(createAnnouncement).toHaveBeenCalledWith({
      title: '维护公告',
      summary: '今晚维护',
      bodyMarkdown: '今晚 23:00 维护',
      status: 'published',
      priority: 10,
      startsAt: null,
      endsAt: null,
      ctaLabel: '查看详情',
      ctaHref: '/announcements/maintenance',
    });
  });

  it('rejects user manager keys from managing announcements', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/announcements',
      headers: {
        'x-admin-key': 'test-user-manager-key',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: '无权访问该管理功能' });
    expect(listAdminAnnouncements).not.toHaveBeenCalled();
  });

  it('validates announcement CTA links before creating', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/announcements',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
      payload: {
        title: '坏链接',
        body_markdown: '正文',
        cta_label: '点击',
        cta_href: 'javascript:alert(1)',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'CTA 链接只允许站内路径或 https:// 外链',
    });
    expect(createAnnouncement).not.toHaveBeenCalled();
  });

  it('merges current announcement state before validating patch requests', async () => {
    vi.mocked(getAdminAnnouncementById).mockResolvedValueOnce(
      announcementFixture({
        starts_at: '2026-06-12T00:00:00.000Z',
        cta_label: '查看详情',
        cta_href: '/announcements/maintenance',
      }) as Awaited<ReturnType<typeof getAdminAnnouncementById>>,
    );
    vi.mocked(updateAnnouncement).mockResolvedValueOnce(
      announcementFixture({
        ends_at: '2026-06-13T00:00:00.000Z',
      }) as Awaited<ReturnType<typeof updateAnnouncement>>,
    );

    const response = await app.inject({
      method: 'PATCH',
      url: '/announcements/announcement-1',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
      payload: {
        ends_at: '2026-06-13T00:00:00.000Z',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateAnnouncement).toHaveBeenCalledWith('announcement-1', {
      title: undefined,
      summary: undefined,
      bodyMarkdown: undefined,
      status: undefined,
      priority: undefined,
      startsAt: undefined,
      endsAt: '2026-06-13T00:00:00.000Z',
      ctaLabel: undefined,
      ctaHref: undefined,
    });
  });

  it('rejects hard deletion for published announcements', async () => {
    vi.mocked(getAdminAnnouncementById).mockResolvedValueOnce(
      announcementFixture({ status: 'published' }) as Awaited<
        ReturnType<typeof getAdminAnnouncementById>
      >,
    );
    vi.mocked(deleteDraftAnnouncement).mockResolvedValueOnce({
      deleted: false,
      blockedStatus: 'published',
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/announcements/announcement-1',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: '已发布或已归档公告请使用归档，不允许硬删除',
    });
  });

  it('maps announcement slug conflicts to a readable response', async () => {
    vi.mocked(createAnnouncement).mockRejectedValueOnce({
      code: '23505',
      constraint: 'announcements_slug_key',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/announcements',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
      payload: {
        title: '维护公告',
        body_markdown: '正文',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: '公告 slug 已存在' });
  });

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
    expect(clearLogsResponse.statusCode).toBe(403);
    expect(deleteResponse.statusCode).toBe(403);
    expect(grantBonusBalance).not.toHaveBeenCalled();
    expect(adjustUserPurchasedBalance).not.toHaveBeenCalled();
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
    const announcementsResponse = await app.inject({
      method: 'GET',
      url: '/announcements',
      headers: {
        'x-admin-key': 'test-user-manager-key',
      },
    });

    expect(statsResponse.statusCode).toBe(403);
    expect(logsResponse.statusCode).toBe(403);
    expect(billingResponse.statusCode).toBe(403);
    expect(announcementsResponse.statusCode).toBe(403);
    expect(getAdminGlobalStats).not.toHaveBeenCalled();
    expect(listRechargeOrdersForAdmin).not.toHaveBeenCalled();
    expect(listAdminAnnouncements).not.toHaveBeenCalled();
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
      default_official_model_id: 'official-1',
      default_thinking_level: 'high',
      pi_session_health_enabled: true,
      pi_session_inactive_cleanup_days: 45,
      pi_session_orphan_grace_days: 60,
      skill_bundle_max_files: 80,
      skill_bundle_max_file_chars: 200_000,
      skill_bundle_max_total_chars: 800_000,
      skill_bundle_max_zip_bytes: 16 * 1024 * 1024,
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
        default_official_model_id: 'official-1',
        default_thinking_level: 'high',
        pi_session_health_enabled: true,
        pi_session_inactive_cleanup_days: 45,
        pi_session_orphan_grace_days: 60,
        skill_bundle_max_files: 80,
        skill_bundle_max_file_chars: 200_000,
        skill_bundle_max_total_chars: 800_000,
        skill_bundle_max_zip_bytes: 16 * 1024 * 1024,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateRuntimeSettings).toHaveBeenCalledWith({
      agentConcurrencyLimit: 1,
      localAgentMaxProcesses: 2,
      localAgentIdleTtlMs: 120_000,
      defaultOfficialModelId: 'official-1',
      defaultThinkingLevel: 'high',
      piSessionHealthEnabled: true,
      piSessionInactiveCleanupDays: 45,
      piSessionOrphanGraceDays: 60,
      skillBundleMaxFiles: 80,
      skillBundleMaxFileChars: 200_000,
      skillBundleMaxTotalChars: 800_000,
      skillBundleMaxZipBytes: 16 * 1024 * 1024,
      actor: 'manager',
    });
  });

  it('keeps runtime config update compatible with old clients', async () => {
    vi.mocked(updateRuntimeSettings).mockResolvedValueOnce({
      agent_concurrency_limit: 3,
      local_agent_max_processes: 4,
      local_agent_idle_ttl_ms: 600_000,
      default_official_model_id: null,
      default_thinking_level: 'medium',
      pi_session_health_enabled: false,
      pi_session_inactive_cleanup_days: 30,
      pi_session_orphan_grace_days: 30,
      skill_bundle_max_files: 50,
      skill_bundle_max_file_chars: 100_000,
      skill_bundle_max_total_chars: 500_000,
      skill_bundle_max_zip_bytes: 8 * 1024 * 1024,
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
      defaultOfficialModelId: undefined,
      defaultThinkingLevel: undefined,
      piSessionHealthEnabled: undefined,
      piSessionInactiveCleanupDays: undefined,
      piSessionOrphanGraceDays: undefined,
      skillBundleMaxFiles: undefined,
      skillBundleMaxFileChars: undefined,
      skillBundleMaxTotalChars: undefined,
      skillBundleMaxZipBytes: undefined,
      actor: 'manager',
    });
  });

  it('rejects Skill Bundle runtime limits when total chars is smaller than single file chars', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/system-config/runtime',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
      payload: {
        agent_concurrency_limit: 1,
        skill_bundle_max_file_chars: 100,
        skill_bundle_max_total_chars: 99,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(updateRuntimeSettings).not.toHaveBeenCalled();
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

  it('rejects runtime config outside Pi session health policy ranges', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/system-config/runtime',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
      payload: {
        agent_concurrency_limit: 1,
        pi_session_inactive_cleanup_days: 0,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(updateRuntimeSettings).not.toHaveBeenCalled();
  });

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

  it('returns simple workflow selectable resources for owner admins', async () => {
    vi.mocked(listAdminSkillBundleSummaries).mockResolvedValueOnce([
      {
        id: 'bundle-1',
        user_id: 'user-1',
        owner_phone: '13800000000',
        name: '新手入门套件',
        description: '六爻基础',
        skill_ids: ['skill-1'],
        skill_names: ['六爻入门'],
        visibility: 'private',
        created_at: '2026-06-09T00:00:00.000Z',
        updated_at: '2026-06-09T00:00:00.000Z',
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/simple-workflows/resources',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      skill_bundles: [
        expect.objectContaining({
          id: 'bundle-1',
          name: '新手入门套件',
          skill_names: ['六爻入门'],
        }),
      ],
    });
  });

  it('accepts xhigh thinking level for simple workflow model policy', async () => {
    vi.mocked(updateSimpleWorkflowPreset).mockResolvedValueOnce({
      id: 'simple-divination-default',
      kind: 'divination',
      name: '默认占卜问事',
      enabled: true,
      is_default: true,
      entry_title: '占卜问事',
      entry_description: '',
      paipan_skill: 'iching-paipan',
      paipan_input_defaults: { method: 'dayan' },
      model_policy: {
        mode: 'fixed',
        fixedModelId: 'model-1',
        thinkingLevel: 'xhigh',
      },
      skill_bundle_ids: [],
      prompt_template: '模板',
      sort_order: 10,
      created_at: '2026-06-09T00:00:00.000Z',
      updated_at: '2026-06-09T00:00:00.000Z',
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/simple-workflows/simple-divination-default',
      headers: {
        'x-admin-key': 'test-manager-key',
      },
      payload: {
        model_policy: {
          mode: 'fixed',
          fixedModelId: 'model-1',
          thinkingLevel: 'xhigh',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateSimpleWorkflowPreset).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'simple-divination-default',
        modelPolicy: {
          mode: 'fixed',
          fixedModelId: 'model-1',
          thinkingLevel: 'xhigh',
        },
      }),
    );
  });
});
