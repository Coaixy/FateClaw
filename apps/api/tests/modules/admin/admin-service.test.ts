import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateUser,
  mockCancelUserMembershipsForAdmin,
  mockCreateAnnouncement,
  mockCreatePublicFinancialLedgerEntry,
  mockDeleteDraftAnnouncement,
  mockDeletePublicFinancialLedgerEntry,
  mockDeletePiSessionFilesForSession,
  mockDeletePiSessionOrphanFiles,
  mockGetChatSessionPiArchiveStates,
  mockGetChatSessionPiCleanupCandidates,
  mockGetChatSessionPiSessionArchive,
  mockGetConversationLogByRequestId,
  mockGetPiSessionHealthPolicy,
  mockGetMembershipEntitlements,
  mockGetPiSessionCleanupCursor,
  mockGetAdminAnnouncementById,
  mockGetRecentMessages,
  mockGetUserById,
  mockGetUserByPhone,
  mockListBillingRequestReservationsPageForAdmin,
  mockListAdminAnnouncements,
  mockListRechargeOrdersForAdmin,
  mockListPublicFinancialLedgerEntries,
  mockListWalletTransactionsForAdmin,
  mockMarkChatSessionPiSessionArchived,
  mockReadPiSessionArchiveForSession,
  mockResetPiSessionCleanupCursor,
  mockScanPiSessionOrphanFiles,
  mockSetUserMembershipForAdmin,
  mockWritePiSessionSnapshotArchiveToFiles,
  mockUpdateDailySignInConfig,
  mockUpdateAnnouncement,
  mockUpdatePublicFinancialLedgerEntry,
  mockUpdateUserPasswordHash,
  mockUpsertPiSessionCleanupCursor,
} = vi.hoisted(() => ({
  mockCreateUser: vi.fn(),
  mockCancelUserMembershipsForAdmin: vi.fn(),
  mockCreateAnnouncement: vi.fn(),
  mockCreatePublicFinancialLedgerEntry: vi.fn(),
  mockDeleteDraftAnnouncement: vi.fn(),
  mockDeletePublicFinancialLedgerEntry: vi.fn(),
  mockDeletePiSessionFilesForSession: vi.fn(),
  mockDeletePiSessionOrphanFiles: vi.fn(),
  mockGetChatSessionPiArchiveStates: vi.fn(),
  mockGetChatSessionPiCleanupCandidates: vi.fn(),
  mockGetChatSessionPiSessionArchive: vi.fn(),
  mockGetConversationLogByRequestId: vi.fn(),
  mockGetPiSessionHealthPolicy: vi.fn(),
  mockGetMembershipEntitlements: vi.fn(),
  mockGetPiSessionCleanupCursor: vi.fn(),
  mockGetAdminAnnouncementById: vi.fn(),
  mockGetRecentMessages: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetUserByPhone: vi.fn(),
  mockListBillingRequestReservationsPageForAdmin: vi.fn(),
  mockListAdminAnnouncements: vi.fn(),
  mockListRechargeOrdersForAdmin: vi.fn(),
  mockListPublicFinancialLedgerEntries: vi.fn(),
  mockListWalletTransactionsForAdmin: vi.fn(),
  mockMarkChatSessionPiSessionArchived: vi.fn(),
  mockReadPiSessionArchiveForSession: vi.fn(),
  mockResetPiSessionCleanupCursor: vi.fn(),
  mockScanPiSessionOrphanFiles: vi.fn(),
  mockSetUserMembershipForAdmin: vi.fn(),
  mockWritePiSessionSnapshotArchiveToFiles: vi.fn(),
  mockUpdateDailySignInConfig: vi.fn(),
  mockUpdateAnnouncement: vi.fn(),
  mockUpdatePublicFinancialLedgerEntry: vi.fn(),
  mockUpdateUserPasswordHash: vi.fn(),
  mockUpsertPiSessionCleanupCursor: vi.fn(),
}));

vi.mock('../../../src/infrastructure/db.js', () => ({
  cancelUserMembershipsForAdmin: mockCancelUserMembershipsForAdmin,
  createAnnouncement: mockCreateAnnouncement,
  createPublicFinancialLedgerEntry: mockCreatePublicFinancialLedgerEntry,
  createUser: mockCreateUser,
  deleteDraftAnnouncement: mockDeleteDraftAnnouncement,
  deletePublicFinancialLedgerEntry: mockDeletePublicFinancialLedgerEntry,
  getChatSessionPiArchiveStates: mockGetChatSessionPiArchiveStates,
  getChatSessionPiCleanupCandidates: mockGetChatSessionPiCleanupCandidates,
  getChatSessionPiSessionArchive: mockGetChatSessionPiSessionArchive,
  getConversationLogByRequestId: mockGetConversationLogByRequestId,
  getAdminAnnouncementById: mockGetAdminAnnouncementById,
  getMembershipEntitlements: mockGetMembershipEntitlements,
  getPiSessionCleanupCursor: mockGetPiSessionCleanupCursor,
  getRecentMessages: mockGetRecentMessages,
  getUserById: mockGetUserById,
  getUserByPhone: mockGetUserByPhone,
  listBillingRequestReservationsPageForAdmin:
    mockListBillingRequestReservationsPageForAdmin,
  listAdminAnnouncements: mockListAdminAnnouncements,
  listRechargeOrdersForAdmin: mockListRechargeOrdersForAdmin,
  listPublicFinancialLedgerEntries: mockListPublicFinancialLedgerEntries,
  listWalletTransactionsForAdmin: mockListWalletTransactionsForAdmin,
  markChatSessionPiSessionArchived: mockMarkChatSessionPiSessionArchived,
  resetPiSessionCleanupCursor: mockResetPiSessionCleanupCursor,
  setUserMembershipForAdmin: mockSetUserMembershipForAdmin,
  updateAnnouncement: mockUpdateAnnouncement,
  updatePublicFinancialLedgerEntry: mockUpdatePublicFinancialLedgerEntry,
  updateUserPasswordHash: mockUpdateUserPasswordHash,
  upsertPiSessionCleanupCursor: mockUpsertPiSessionCleanupCursor,
}));

vi.mock('../../../src/modules/chat/pi-session-files.js', () => ({
  deletePiSessionFilesForSession: mockDeletePiSessionFilesForSession,
  deletePiSessionOrphanFiles: mockDeletePiSessionOrphanFiles,
  readPiSessionArchiveForSession: mockReadPiSessionArchiveForSession,
  readPiSessionSnapshotFromTraceEvents: vi.fn((traceEvents: unknown) => {
    if (!Array.isArray(traceEvents)) return null;
    const event = traceEvents.find(
      (item) =>
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        (item as { type?: unknown }).type === 'pi_session_snapshot',
    );
    return event && typeof event === 'object' && !Array.isArray(event)
      ? ((event as { session?: unknown }).session ?? null)
      : null;
  }),
  scanPiSessionOrphanFiles: mockScanPiSessionOrphanFiles,
  writePiSessionSnapshotArchiveToFiles:
    mockWritePiSessionSnapshotArchiveToFiles,
}));

vi.mock('../../../src/modules/system/system-config.js', () => ({
  createOfficialModel: vi.fn(),
  getPiSessionHealthPolicy: mockGetPiSessionHealthPolicy,
  getSystemConfigOverview: vi.fn(),
  removeOfficialModel: vi.fn(),
  updateModelBillingSettings: vi.fn(),
  updateRuntimeSettings: vi.fn(),
  updateOfficialModel: vi.fn(),
}));

import {
  cleanupPiSessionFilesForAdmin,
  createAdminUser,
  resetAdminUserPassword,
  scanPiSessionOrphanFilesForAdmin,
} from '../../../src/modules/admin/admin-service.js';

describe('createAdminUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserByPhone.mockResolvedValue(undefined);
    mockCreateUser.mockResolvedValue(undefined);
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

describe('resetAdminUserPassword', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserById.mockResolvedValue({
      id: 'user-1',
      password_hash: 'old-hash',
      auth_token_version: 2,
    });
    mockUpdateUserPasswordHash.mockResolvedValue({
      id: 'user-1',
      password_hash: 'next-hash',
      auth_token_version: 3,
    });
  });

  it('hashes the new password and returns the bumped auth token version', async () => {
    await expect(
      resetAdminUserPassword({
        userId: 'user-1',
        password: 'new-password',
      }),
    ).resolves.toEqual({
      id: 'user-1',
      auth_token_version: 3,
    });

    expect(mockGetUserById).toHaveBeenCalledWith('user-1');
    expect(mockUpdateUserPasswordHash).toHaveBeenCalledWith(
      'user-1',
      expect.stringMatching(/^\$2/),
    );
    expect(mockUpdateUserPasswordHash.mock.calls[0]?.[1]).not.toBe(
      'new-password',
    );
  });

  it('rejects missing users before hashing', async () => {
    mockGetUserById.mockResolvedValue(undefined);

    await expect(
      resetAdminUserPassword({
        userId: 'missing-user',
        password: 'new-password',
      }),
    ).rejects.toThrow('用户不存在');

    expect(mockUpdateUserPasswordHash).not.toHaveBeenCalled();
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
        account_id: 'web:user-1',
        updated_at: '2026-05-30T01:00:00.000Z',
        deleted_at: '2026-05-30T02:00:00.000Z',
        pi_session_archived_at: null,
      },
    ]);
    mockGetChatSessionPiSessionArchive.mockResolvedValue(undefined);
    mockGetRecentMessages.mockResolvedValue([]);
    mockGetConversationLogByRequestId.mockResolvedValue(undefined);
    mockWritePiSessionSnapshotArchiveToFiles.mockResolvedValue(null);
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

  it('reuses existing archive payload before deleting residual local files', async () => {
    mockGetChatSessionPiCleanupCandidates.mockResolvedValueOnce([
      {
        id: 'session-archived',
        account_id: 'web:user-1',
        updated_at: '2026-05-30T01:00:00.000Z',
        deleted_at: '2026-05-30T02:00:00.000Z',
        pi_session_archived_at: '2026-05-30T03:00:00.000Z',
      },
    ]);
    mockGetChatSessionPiSessionArchive.mockResolvedValueOnce({
      id: 'session-archived',
      pi_session_archived_at: '2026-05-30T03:00:00.000Z',
      pi_session_archive_reason: 'soft_deleted',
      pi_session_archive_payload: {
        version: 1,
        mapping_file_name: 'session-archived.path',
        mapping_content: 'session-archived.jsonl',
        files: [
          {
            name: 'session-archived.jsonl',
            content: '{"type":"turn"}\n',
            size_bytes: 16,
            modified_at: '2026-05-30T01:00:00.000Z',
          },
        ],
        archived_at: '2026-05-30T02:00:00.000Z',
      },
      pi_session_archive_restored_at: null,
    });

    await expect(
      cleanupPiSessionFilesForAdmin({
        mode: 'soft_deleted',
        limit: 10,
      }),
    ).resolves.toMatchObject({
      scanned_sessions: 1,
      archived_sessions: 0,
      already_archived_sessions: 1,
      deleted_jsonl_files: 1,
      deleted_path_files: 1,
    });

    expect(mockReadPiSessionArchiveForSession).not.toHaveBeenCalled();
    expect(mockMarkChatSessionPiSessionArchived).not.toHaveBeenCalled();
    expect(mockDeletePiSessionFilesForSession).toHaveBeenCalledWith(
      'session-archived',
    );
  });

  it('restores missing cleanup payload from conversation log snapshot', async () => {
    mockReadPiSessionArchiveForSession.mockResolvedValueOnce({
      sessionId: 'session-2',
      payload: {
        version: 1,
        mapping_file_name: 'session-2.path',
        mapping_content: null,
        files: [],
        archived_at: '2026-05-30T02:00:00.000Z',
      },
      missingSessionFile: true,
      skippedUnsafeSessionFiles: [],
    });
    mockGetRecentMessages.mockResolvedValueOnce([
      {
        id: 'reply-1',
        account_id: 'web:user-1',
        sender: 'assistant',
        sender_name: '命枢',
        content: '结果',
        timestamp: '2026-05-30T02:00:00.000Z',
        is_bot_message: true,
        session_id: 'session-2',
        metadata: { request_id: 'request-1' },
      },
    ]);
    mockGetConversationLogByRequestId.mockResolvedValueOnce({
      id: 'log-1',
      account_id: 'web:user-1',
      request_id: 'request-1',
      transcript: [],
      usage: null,
      model: 'gpt-4.1',
      provider: 'openai-completions',
      trace_events: [
        {
          type: 'pi_session_snapshot',
          session: {
            provider: 'openai-completions',
            model: 'gpt-4.1',
            messages: [{ role: 'user', content: '继续' }],
          },
        },
      ],
      agent_graph: null,
      agent_graph_summary: null,
      capability_ledger: null,
      created_at: '2026-05-30T02:00:00.000Z',
    });
    mockWritePiSessionSnapshotArchiveToFiles.mockResolvedValueOnce({
      payload: {
        version: 1,
        mapping_file_name: 'session-2.path',
        mapping_content: 'session-2.jsonl',
        files: [
          {
            name: 'session-2.jsonl',
            content: '{"type":"session"}\n',
            size_bytes: 19,
            modified_at: '2026-05-30T02:00:00.000Z',
          },
        ],
        archived_at: '2026-05-30T02:00:00.000Z',
      },
      writtenSessionFiles: 1,
      writtenMappingFile: true,
      snapshotMessageCount: 1,
    });

    await expect(
      cleanupPiSessionFilesForAdmin({
        mode: 'inactive',
        inactiveDays: 30,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      archived_sessions: 1,
      payload_restored_from_snapshot: 1,
      unarchivable_sessions: 0,
      deleted_jsonl_files: 1,
    });

    expect(mockMarkChatSessionPiSessionArchived).toHaveBeenCalledWith({
      sessionId: 'session-2',
      reason: 'inactive',
      payload: expect.objectContaining({
        mapping_content: 'session-2.jsonl',
      }),
    });
  });

  it('does not mark or delete sessions without any restorable payload', async () => {
    mockReadPiSessionArchiveForSession.mockResolvedValueOnce({
      sessionId: 'session-2',
      payload: {
        version: 1,
        mapping_file_name: 'session-2.path',
        mapping_content: null,
        files: [],
        archived_at: '2026-05-30T02:00:00.000Z',
      },
      missingSessionFile: true,
      skippedUnsafeSessionFiles: [],
    });

    await expect(
      cleanupPiSessionFilesForAdmin({
        mode: 'soft_deleted',
        limit: 10,
      }),
    ).resolves.toMatchObject({
      scanned_sessions: 1,
      archived_sessions: 0,
      unarchivable_sessions: 1,
      deleted_jsonl_files: 0,
      deleted_path_files: 0,
    });

    expect(mockMarkChatSessionPiSessionArchived).not.toHaveBeenCalled();
    expect(mockDeletePiSessionFilesForSession).not.toHaveBeenCalled();
  });

  it('resets cursor and starts over when the cursor reaches the end', async () => {
    mockGetChatSessionPiCleanupCandidates
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'session-0',
          account_id: 'web:user-1',
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

  it('uses runtime policy days when inactive cleanup omits inactiveDays', async () => {
    mockGetPiSessionHealthPolicy.mockResolvedValueOnce({
      enabled: true,
      inactiveCleanupDays: 45,
      orphanGraceDays: 30,
    });

    await cleanupPiSessionFilesForAdmin({
      mode: 'inactive',
      limit: 10,
    });

    expect(mockGetPiSessionHealthPolicy).toHaveBeenCalled();
    expect(mockGetChatSessionPiCleanupCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        softDeleted: false,
        limit: 10,
      }),
    );
  });
});

describe('scanPiSessionOrphanFilesForAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPiSessionHealthPolicy.mockResolvedValue({
      enabled: true,
      inactiveCleanupDays: 30,
      orphanGraceDays: 30,
    });
    mockScanPiSessionOrphanFiles.mockResolvedValue({
      session_dir: '/tmp/pi-sessions',
      total_files: 5,
      scanned_files: 5,
      truncated: false,
      scanned_path_files: 2,
      scanned_jsonl_files: 2,
      dangling_path_files: [
        {
          kind: 'dangling_path',
          name: 'session-missing.path',
          path: '/tmp/pi-sessions/session-missing.path',
          session_id: 'session-missing',
          size_bytes: 12,
          modified_at: '2000-01-01T00:00:00.000Z',
        },
      ],
      unmapped_jsonl_files: [
        {
          kind: 'unmapped_jsonl',
          name: '2026_session-active.jsonl',
          path: '/tmp/pi-sessions/2026_session-active.jsonl',
          session_id: 'session-active',
          size_bytes: 20,
          modified_at: '2000-01-01T00:00:00.000Z',
        },
      ],
      unknown_files: ['notes.txt'],
      unsafe_path_files: ['session-unsafe.path'],
    });
    mockGetChatSessionPiArchiveStates.mockResolvedValue([
      {
        id: 'session-active',
        pi_session_archived_at: null,
        has_pi_session_archive_payload: false,
      },
    ]);
    mockDeletePiSessionOrphanFiles.mockResolvedValue({
      deleted_path_files: 1,
      deleted_jsonl_files: 0,
      skipped_unsafe_files: [],
    });
  });

  it('audits orphan files without deleting them', async () => {
    await expect(
      scanPiSessionOrphanFilesForAdmin({ action: 'audit' }),
    ).resolves.toMatchObject({
      action: 'audit',
      grace_days: 30,
      dangling_path_files: 1,
      unmapped_jsonl_files: 1,
      unknown_files: 1,
      unsafe_path_files: 1,
      safe_deletable_files: 1,
      deleted_path_files: 0,
      deleted_jsonl_files: 0,
      skipped_unarchived_files: 1,
    });

    expect(mockDeletePiSessionOrphanFiles).not.toHaveBeenCalled();
  });

  it('deletes only safe orphan files when action is delete', async () => {
    await scanPiSessionOrphanFilesForAdmin({ action: 'delete' });

    expect(mockDeletePiSessionOrphanFiles).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'dangling_path',
        session_id: 'session-missing',
      }),
    ]);
  });
});
