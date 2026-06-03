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

describe('adminRoutes authentication throttling', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRateLimitCheck.mockResolvedValue({ allowed: true });
    mockRateLimitRecordFail.mockResolvedValue(undefined);
    mockRateLimitClear.mockResolvedValue(undefined);

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
});
