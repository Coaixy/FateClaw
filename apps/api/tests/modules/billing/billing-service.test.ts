import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetUserById,
  mockSubscribe,
  mockGetWallet,
  mockGetMembership,
  mockRedisSet,
  mockRedisDel,
} = vi.hoisted(() => ({
  mockGetUserById: vi.fn(),
  mockSubscribe: vi.fn(),
  mockGetWallet: vi.fn(),
  mockGetMembership: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisDel: vi.fn(),
}));

vi.mock('../../../src/infrastructure/db.js', () => ({
  getUserById: mockGetUserById,
  subscribeMembershipWithWallet: mockSubscribe,
  getAccountsByUserId: vi.fn(),
  getMembershipEntitlements: vi.fn(),
  getVisibleWalletTransactionsByUserId: vi.fn(),
  resetUserData: vi.fn(),
  resetUserMessages: vi.fn(),
  updateSoulContent: vi.fn(),
  updateUserSoulContent: vi.fn(),
}));

vi.mock('../../../src/infrastructure/daily-usage.js', () => ({
  getDailyUsageRows: vi.fn(),
  getUsageStats: vi.fn(),
}));

vi.mock('../../../src/modules/billing/plans.js', () => ({
  getMonthlyMeteredBillingSummary: vi.fn(),
  getMembershipBillingSummary: mockGetMembership,
  getMembershipPlanSummaries: vi.fn(),
  getWalletBalanceSummary: mockGetWallet,
}));

vi.mock('../../../src/infrastructure/redis.js', () => ({
  getRedis: () => ({ set: mockRedisSet, del: mockRedisDel }),
}));

import { subscribeCurrentUserMembership } from '../../../src/modules/billing/billing-service.js';

describe('subscribeCurrentUserMembership 幂等防抖', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisDel.mockResolvedValue(1);
    mockGetUserById.mockResolvedValue({ id: 'user-1' });
    mockSubscribe.mockResolvedValue({ user: { id: 'user-1' } });
    mockGetWallet.mockResolvedValue({
      purchasedCoins: 0,
      bonusCoins: 0,
      reservedCoins: 0,
      availableCoins: 0,
    });
    mockGetMembership.mockResolvedValue({
      enabled: true,
      active: true,
      planKey: 'fateclaw_clarity',
      monthlyPriceCoins: 10,
      displayPriceCoins: 10,
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });
  });

  it('拿到去重锁时正常开通一次', async () => {
    mockRedisSet.mockResolvedValue('OK');

    const result = await subscribeCurrentUserMembership('user-1');

    expect(result.ok).toBe(true);
    expect(mockRedisSet).toHaveBeenCalledWith(
      'billing:subscribe:lock:user-1',
      '1',
      'EX',
      10,
      'NX',
    );
    expect(mockSubscribe).toHaveBeenCalledOnce();
  });

  it('短时间重复提交(锁被占)直接拒绝,不重复扣费', async () => {
    mockRedisSet.mockResolvedValue(null);

    const result = await subscribeCurrentUserMembership('user-1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(429);
    }
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('开通失败(未扣费)时释放锁以便立即重试', async () => {
    mockRedisSet.mockResolvedValue('OK');
    mockSubscribe.mockRejectedValue(new Error('积分不足'));

    const result = await subscribeCurrentUserMembership('user-1');

    expect(result.ok).toBe(false);
    expect(mockRedisDel).toHaveBeenCalledWith('billing:subscribe:lock:user-1');
  });
});
