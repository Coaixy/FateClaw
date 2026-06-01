import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateUser,
  mockCreatePublicFinancialLedgerEntry,
  mockDeletePublicFinancialLedgerEntry,
  mockDeletePiSessionFilesForSession,
  mockGetDailySignInConfig,
  mockGetChatSessionPiCleanupCandidates,
  mockGetMembershipConfig,
  mockGetPiSessionCleanupCursor,
  mockGetUserByPhone,
  mockListPublicFinancialLedgerEntries,
  mockMarkChatSessionPiSessionArchived,
  mockReadPiSessionArchiveForSession,
  mockResetPiSessionCleanupCursor,
  mockUpdateDailySignInConfig,
  mockUpdateMembershipConfig,
  mockUpdatePublicFinancialLedgerEntry,
  mockUpsertPiSessionCleanupCursor,
} = vi.hoisted(() => ({
  mockCreateUser: vi.fn(),
  mockCreatePublicFinancialLedgerEntry: vi.fn(),
  mockDeletePublicFinancialLedgerEntry: vi.fn(),
  mockDeletePiSessionFilesForSession: vi.fn(),
  mockGetDailySignInConfig: vi.fn(),
  mockGetChatSessionPiCleanupCandidates: vi.fn(),
  mockGetMembershipConfig: vi.fn(),
  mockGetPiSessionCleanupCursor: vi.fn(),
  mockGetUserByPhone: vi.fn(),
  mockListPublicFinancialLedgerEntries: vi.fn(),
  mockMarkChatSessionPiSessionArchived: vi.fn(),
  mockReadPiSessionArchiveForSession: vi.fn(),
  mockResetPiSessionCleanupCursor: vi.fn(),
  mockUpdateDailySignInConfig: vi.fn(),
  mockUpdateMembershipConfig: vi.fn(),
  mockUpdatePublicFinancialLedgerEntry: vi.fn(),
  mockUpsertPiSessionCleanupCursor: vi.fn(),
}));

vi.mock('../../infrastructure/db.js', () => ({
  createPublicFinancialLedgerEntry: mockCreatePublicFinancialLedgerEntry,
  createUser: mockCreateUser,
  deletePublicFinancialLedgerEntry: mockDeletePublicFinancialLedgerEntry,
  getDailySignInConfig: mockGetDailySignInConfig,
  getChatSessionPiCleanupCandidates: mockGetChatSessionPiCleanupCandidates,
  getMembershipConfig: mockGetMembershipConfig,
  getPiSessionCleanupCursor: mockGetPiSessionCleanupCursor,
  getUserByPhone: mockGetUserByPhone,
  listPublicFinancialLedgerEntries: mockListPublicFinancialLedgerEntries,
  markChatSessionPiSessionArchived: mockMarkChatSessionPiSessionArchived,
  resetPiSessionCleanupCursor: mockResetPiSessionCleanupCursor,
  updateDailySignInConfig: mockUpdateDailySignInConfig,
  updateMembershipConfig: mockUpdateMembershipConfig,
  updatePublicFinancialLedgerEntry: mockUpdatePublicFinancialLedgerEntry,
  upsertPiSessionCleanupCursor: mockUpsertPiSessionCleanupCursor,
}));

vi.mock('../chat/pi-session-files.js', () => ({
  deletePiSessionFilesForSession: mockDeletePiSessionFilesForSession,
  readPiSessionArchiveForSession: mockReadPiSessionArchiveForSession,
}));

import {
  cleanupPiSessionFilesForAdmin,
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
    mockGetMembershipConfig.mockResolvedValue({
      id: 'default',
      enabled: true,
      monthly_price_coins: 30,
      monthly_allowance_units: 3000000,
      standard_price_per_million_units_coins: 10,
      updated_at: '2026-05-30T00:00:00.000Z',
    });
    mockUpdateMembershipConfig.mockResolvedValue({
      id: 'default',
      enabled: true,
      monthly_price_coins: 30,
      monthly_allowance_units: 5000000,
      standard_price_per_million_units_coins: 12,
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
    mockGetMembershipConfig.mockResolvedValue({
      id: 'default',
      enabled: true,
      monthly_price_coins: 30,
      monthly_allowance_units: 3000000,
      standard_price_per_million_units_coins: 10,
      updated_at: '2026-05-30T00:00:00.000Z',
    });
    mockUpdateMembershipConfig.mockResolvedValue({
      id: 'default',
      enabled: true,
      monthly_price_coins: 30,
      monthly_allowance_units: 5000000,
      standard_price_per_million_units_coins: 12,
      updated_at: '2026-05-30T01:00:00.000Z',
    });
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
      membership: {
        enabled: true,
        monthly_price_coins: 30,
        monthly_allowance_units: 3000000,
        standard_price_per_million_units_coins: 10,
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
        membership: {
          enabled: true,
          monthlyPriceCoins: 30,
          monthlyAllowanceUnits: 5000000,
          standardPricePerMillionUnitsCoins: 12,
        },
      }),
    ).resolves.toEqual({
      daily_sign_in: {
        enabled: false,
        reward_coins: 10,
        updated_at: '2026-05-30T01:00:00.000Z',
      },
      membership: {
        enabled: true,
        monthly_price_coins: 30,
        monthly_allowance_units: 5000000,
        standard_price_per_million_units_coins: 12,
        updated_at: '2026-05-30T01:00:00.000Z',
      },
    });

    expect(mockUpdateDailySignInConfig).toHaveBeenCalledWith({
      enabled: false,
      rewardCoins: 10,
    });
    expect(mockUpdateMembershipConfig).toHaveBeenCalledWith({
      enabled: true,
      monthlyPriceCoins: 30,
      monthlyAllowanceUnits: 5000000,
      standardPricePerMillionUnitsCoins: 12,
    });
  });
});

describe('cleanupPiSessionFilesForAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPiSessionCleanupCursor.mockResolvedValue({
      mode: 'soft_deleted',
      cursor_session_id: 'session-1',
      scanned_sessions: 5,
      updated_at: '2026-05-30T00:00:00.000Z',
    });
    mockGetChatSessionPiCleanupCandidates.mockResolvedValue([
      {
        id: 'session-2',
        updated_at: '2026-05-30T01:00:00.000Z',
        deleted_at: '2026-05-30T02:00:00.000Z',
        pi_session_archived_at: null,
      },
    ]);
    mockReadPiSessionArchiveForSession.mockResolvedValue({
      sessionId: 'session-2',
      payload: {
        version: 1,
        mapping_file_name: 'session-2.path',
        mapping_content: 'session-2.jsonl',
        files: [
          {
            name: 'session-2.jsonl',
            content: '{"type":"turn"}\n',
            size_bytes: 16,
            modified_at: '2026-05-30T01:00:00.000Z',
          },
        ],
        archived_at: '2026-05-30T02:00:00.000Z',
      },
      missingSessionFile: false,
      skippedUnsafeSessionFiles: [],
    });
    mockMarkChatSessionPiSessionArchived.mockResolvedValue(true);
    mockDeletePiSessionFilesForSession.mockResolvedValue({
      sessionId: 'session-2',
      deletedMappingFile: true,
      deletedSessionFiles: 1,
      missingSessionFile: false,
      skippedUnsafeSessionFiles: [],
    });
  });

  it('archives and deletes only the next cursor window', async () => {
    await expect(
      cleanupPiSessionFilesForAdmin({
        mode: 'soft_deleted',
        limit: 10,
      }),
    ).resolves.toMatchObject({
      mode: 'soft_deleted',
      cursor_before: 'session-1',
      cursor_after: 'session-2',
      cursor_reset: false,
      scanned_sessions: 1,
      archived_sessions: 1,
      deleted_jsonl_files: 1,
      deleted_path_files: 1,
    });

    expect(mockGetChatSessionPiCleanupCandidates).toHaveBeenCalledWith({
      softDeleted: true,
      inactiveBefore: undefined,
      limit: 10,
      cursor: 'session-1',
    });
    expect(mockMarkChatSessionPiSessionArchived).toHaveBeenCalledWith({
      sessionId: 'session-2',
      reason: 'soft_deleted',
      payload: expect.objectContaining({ version: 1 }),
    });
    expect(mockUpsertPiSessionCleanupCursor).toHaveBeenCalledWith({
      mode: 'soft_deleted',
      cursorSessionId: 'session-2',
      scannedSessions: 1,
    });
  });

  it('resets cursor and starts over when the cursor reaches the end', async () => {
    mockGetChatSessionPiCleanupCandidates
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'session-0',
          updated_at: '2026-05-29T01:00:00.000Z',
          deleted_at: '2026-05-29T02:00:00.000Z',
          pi_session_archived_at: null,
        },
      ]);

    await expect(
      cleanupPiSessionFilesForAdmin({
        mode: 'soft_deleted',
        limit: 10,
      }),
    ).resolves.toMatchObject({
      cursor_before: null,
      cursor_after: 'session-0',
      cursor_reset: true,
      scanned_sessions: 1,
    });

    expect(mockResetPiSessionCleanupCursor).toHaveBeenCalledWith(
      'soft_deleted',
    );
    expect(mockGetChatSessionPiCleanupCandidates).toHaveBeenNthCalledWith(2, {
      softDeleted: true,
      inactiveBefore: undefined,
      limit: 10,
    });
  });
});
