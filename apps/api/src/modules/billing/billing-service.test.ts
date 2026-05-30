import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateDailySignInReward,
  mockGetDailySignInConfig,
  mockGetDailySignInRecordByDate,
  mockGetUserById,
} = vi.hoisted(() => ({
  mockCreateDailySignInReward: vi.fn(),
  mockGetDailySignInConfig: vi.fn(),
  mockGetDailySignInRecordByDate: vi.fn(),
  mockGetUserById: vi.fn(),
}));

vi.mock('../../infrastructure/db.js', () => ({
  createDailySignInReward: mockCreateDailySignInReward,
  getAccountsByUserId: vi.fn(),
  getDailySignInConfig: mockGetDailySignInConfig,
  getDailySignInRecordByDate: mockGetDailySignInRecordByDate,
  getUserById: mockGetUserById,
  getVisibleWalletTransactionsByUserId: vi.fn(),
  resetUserData: vi.fn(),
  resetUserMessages: vi.fn(),
  resetUserTasks: vi.fn(),
  updateSoulContent: vi.fn(),
  updateUserSoulContent: vi.fn(),
}));

vi.mock('../../infrastructure/daily-usage.js', () => ({
  getDailyUsageRows: vi.fn(),
  getPublicStatusStats: vi.fn(),
  getUsageStats: vi.fn(),
}));

vi.mock('./plans.js', () => ({
  getMonthlyMeteredBillingSummary: vi.fn(),
  getWalletBalanceSummary: vi.fn(),
}));

import {
  claimDailySignInReward,
  getDailySignInStatus,
} from './billing-service.js';

const user = {
  id: 'user-1',
  purchased_coins: 100,
  bonus_coins: 10,
  reserved_coins: 0,
};

describe('daily sign-in billing service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserById.mockResolvedValue(user);
    mockGetDailySignInConfig.mockResolvedValue({
      id: 'default',
      enabled: true,
      reward_coins: 20,
      updated_at: '2026-05-30T00:00:00.000Z',
    });
    mockGetDailySignInRecordByDate.mockResolvedValue(undefined);
  });

  it('returns current daily sign-in status', async () => {
    mockGetDailySignInRecordByDate.mockResolvedValue({
      id: 'signin-1',
      user_id: 'user-1',
      sign_in_date: '2026-05-30',
      reward_coins: 20,
      balance_grant_id: 'bg-1',
      created_at: '2026-05-30T00:00:00.000Z',
    });

    await expect(getDailySignInStatus('user-1')).resolves.toMatchObject({
      ok: true,
      data: {
        enabled: true,
        reward_coins: 20,
        signed_in_today: true,
        signed_in_at: '2026-05-30T00:00:00.000Z',
      },
    });
  });

  it('rejects claim when disabled', async () => {
    mockGetDailySignInConfig.mockResolvedValue({
      id: 'default',
      enabled: false,
      reward_coins: 20,
      updated_at: '2026-05-30T00:00:00.000Z',
    });

    await expect(claimDailySignInReward('user-1')).resolves.toEqual({
      ok: false,
      statusCode: 403,
      error: '每日签到暂未开启',
    });
  });

  it('rejects duplicate daily claim', async () => {
    mockGetDailySignInRecordByDate.mockResolvedValue({
      id: 'signin-1',
      user_id: 'user-1',
      sign_in_date: '2026-05-30',
      reward_coins: 20,
      balance_grant_id: 'bg-1',
      created_at: '2026-05-30T00:00:00.000Z',
    });

    await expect(claimDailySignInReward('user-1')).resolves.toEqual({
      ok: false,
      statusCode: 409,
      error: '今日已签到',
    });
    expect(mockCreateDailySignInReward).not.toHaveBeenCalled();
  });

  it('claims daily reward and returns updated balance snapshot', async () => {
    mockCreateDailySignInReward.mockResolvedValue({
      user: {
        ...user,
        bonus_coins: 30,
      },
      record: {
        id: 'signin-1',
        user_id: 'user-1',
        sign_in_date: '2026-05-30',
        reward_coins: 20,
        balance_grant_id: 'bg-1',
        created_at: '2026-05-30T00:00:00.000Z',
      },
      created: true,
    });

    await expect(claimDailySignInReward('user-1')).resolves.toMatchObject({
      ok: true,
      data: {
        enabled: true,
        reward_coins: 20,
        signed_in_today: true,
        signed_in_at: '2026-05-30T00:00:00.000Z',
        received_coins: 20,
        bonus_coins: 30,
        available_coins: 130,
      },
    });
    expect(mockCreateDailySignInReward).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        rewardCoins: 20,
      }),
    );
  });

  it('returns duplicate response when repository reports an existing record', async () => {
    mockCreateDailySignInReward.mockResolvedValue({
      user,
      record: {
        id: 'signin-existing',
        user_id: 'user-1',
        sign_in_date: '2026-05-30',
        reward_coins: 20,
        balance_grant_id: 'bg-existing',
        created_at: '2026-05-30T00:00:00.000Z',
      },
      created: false,
    });

    await expect(claimDailySignInReward('user-1')).resolves.toEqual({
      ok: false,
      statusCode: 409,
      error: '今日已签到',
    });
  });
});
