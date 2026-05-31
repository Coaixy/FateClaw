import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateUser,
  mockCreatePublicFinancialLedgerEntry,
  mockDeletePublicFinancialLedgerEntry,
  mockGetDailySignInConfig,
  mockGetUserByPhone,
  mockListPublicFinancialLedgerEntries,
  mockUpdateDailySignInConfig,
  mockUpdatePublicFinancialLedgerEntry,
} = vi.hoisted(() => ({
  mockCreateUser: vi.fn(),
  mockCreatePublicFinancialLedgerEntry: vi.fn(),
  mockDeletePublicFinancialLedgerEntry: vi.fn(),
  mockGetDailySignInConfig: vi.fn(),
  mockGetUserByPhone: vi.fn(),
  mockListPublicFinancialLedgerEntries: vi.fn(),
  mockUpdateDailySignInConfig: vi.fn(),
  mockUpdatePublicFinancialLedgerEntry: vi.fn(),
}));

vi.mock('../../infrastructure/db.js', () => ({
  createPublicFinancialLedgerEntry: mockCreatePublicFinancialLedgerEntry,
  createUser: mockCreateUser,
  deletePublicFinancialLedgerEntry: mockDeletePublicFinancialLedgerEntry,
  getDailySignInConfig: mockGetDailySignInConfig,
  getUserByPhone: mockGetUserByPhone,
  listPublicFinancialLedgerEntries: mockListPublicFinancialLedgerEntries,
  updateDailySignInConfig: mockUpdateDailySignInConfig,
  updatePublicFinancialLedgerEntry: mockUpdatePublicFinancialLedgerEntry,
}));

import {
  createAdminUser,
  getAdminRewardConfig,
  updateAdminRewardConfig,
} from './admin-service.js';

describe('createAdminUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserByPhone.mockResolvedValue(undefined);
    mockCreateUser.mockResolvedValue(undefined);
    mockGetDailySignInConfig.mockResolvedValue({
      id: 'default',
      enabled: true,
      reward_coins: 20,
      updated_at: '2026-05-30T00:00:00.000Z',
    });
    mockUpdateDailySignInConfig.mockResolvedValue({
      id: 'default',
      enabled: false,
      reward_coins: 10,
      updated_at: '2026-05-30T01:00:00.000Z',
    });
  });

  it('normalizes phone and persists a hashed admin-created user', async () => {
    const result = await createAdminUser({
      phone: '+86 138-0013-8000',
      password: 'initial-password',
      role: 'creator',
      phoneVerified: true,
    });

    expect(result.id).toEqual(expect.any(String));
    expect(mockGetUserByPhone).toHaveBeenCalledWith('13800138000');
    expect(mockCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({
        id: result.id,
        phone: '13800138000',
        phone_verified: true,
        role: 'creator',
        purchased_coins: 0,
        bonus_coins: 0,
        reserved_coins: 0,
      }),
    );
    const created = mockCreateUser.mock.calls[0]?.[0];
    expect(created.password_hash).not.toBe('initial-password');
    expect(created.password_hash).toEqual(expect.stringMatching(/^\$2/));
  });

  it('rejects duplicate phones before hashing', async () => {
    mockGetUserByPhone.mockResolvedValue({ id: 'existing-user' });

    await expect(
      createAdminUser({
        phone: '13800138000',
        password: 'initial-password',
        role: 'consumer',
        phoneVerified: true,
      }),
    ).rejects.toThrow('该手机号已存在');

    expect(mockCreateUser).not.toHaveBeenCalled();
  });
});

describe('admin reward config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads daily sign-in reward config', async () => {
    mockGetDailySignInConfig.mockResolvedValue({
      id: 'default',
      enabled: true,
      reward_coins: 20,
      updated_at: '2026-05-30T00:00:00.000Z',
    });

    await expect(getAdminRewardConfig()).resolves.toEqual({
      daily_sign_in: {
        enabled: true,
        reward_coins: 20,
        updated_at: '2026-05-30T00:00:00.000Z',
      },
    });
  });

  it('updates daily sign-in reward config', async () => {
    mockUpdateDailySignInConfig.mockResolvedValue({
      id: 'default',
      enabled: false,
      reward_coins: 10,
      updated_at: '2026-05-30T01:00:00.000Z',
    });

    await expect(
      updateAdminRewardConfig({
        dailySignIn: {
          enabled: false,
          rewardCoins: 10,
        },
      }),
    ).resolves.toEqual({
      daily_sign_in: {
        enabled: false,
        reward_coins: 10,
        updated_at: '2026-05-30T01:00:00.000Z',
      },
    });

    expect(mockUpdateDailySignInConfig).toHaveBeenCalledWith({
      enabled: false,
      rewardCoins: 10,
    });
  });
});
