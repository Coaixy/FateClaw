import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockArchiveChatSession,
  mockGetArchivedChatSessionsByUserId,
  mockGetChatSession,
  mockGetChatSessionPiSessionArchive,
  mockGetConversationLogByRequestId,
  mockGetRecentMessages,
  mockGetSessionMessageById,
  mockGetSessionMessages,
  mockGetSessionMessagesWithToolContext,
  mockGetSharedChatSessionByToken,
  mockGetMembershipOverview,
  mockClaimProfessionalAiTurn,
  mockReleaseProfessionalAiTurn,
  mockGetUserById,
  mockGetAccountsByUserId,
  mockHasFinalAiChatSessionReply,
  mockMarkChatSessionPiSessionArchived,
  mockMarkChatSessionPiSessionArchiveRestored,
  mockDeletePiSessionFilesForSession,
  mockReadPiSessionArchiveForSession,
  mockReadPiSessionFileState,
  mockRestoreArchivedChatSession,
  mockWritePiSessionSnapshotArchiveToFiles,
  mockWritePiSessionArchiveToFiles,
  mockShareOwnedChatSession,
  mockIncrementDailyMessageCount,
  mockStoreMessage,
  mockTouchChatSession,
  mockUpdateChatSessionTitle,
  mockDispatchAiChatPrompt,
  mockCancelAiChatSessionRequest,
  mockBuildStructuredInputForSession,
  mockRedisDel,
  mockRedisEval,
  mockRedisGet,
  mockRedisSet,
} = vi.hoisted(() => ({
  mockArchiveChatSession: vi.fn(),
  mockGetArchivedChatSessionsByUserId: vi.fn(),
  mockGetChatSession: vi.fn(),
  mockGetChatSessionPiSessionArchive: vi.fn(),
  mockGetConversationLogByRequestId: vi.fn(),
  mockGetRecentMessages: vi.fn(),
  mockGetSessionMessageById: vi.fn(),
  mockGetSessionMessages: vi.fn(),
  mockGetSessionMessagesWithToolContext: vi.fn(),
  mockGetSharedChatSessionByToken: vi.fn(),
  mockGetMembershipOverview: vi.fn(),
  mockClaimProfessionalAiTurn: vi.fn(),
  mockReleaseProfessionalAiTurn: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetAccountsByUserId: vi.fn(),
  mockHasFinalAiChatSessionReply: vi.fn(),
  mockMarkChatSessionPiSessionArchived: vi.fn(),
  mockMarkChatSessionPiSessionArchiveRestored: vi.fn(),
  mockDeletePiSessionFilesForSession: vi.fn(),
  mockReadPiSessionArchiveForSession: vi.fn(),
  mockReadPiSessionFileState: vi.fn(),
  mockRestoreArchivedChatSession: vi.fn(),
  mockWritePiSessionSnapshotArchiveToFiles: vi.fn(),
  mockWritePiSessionArchiveToFiles: vi.fn(),
  mockShareOwnedChatSession: vi.fn(),
  mockIncrementDailyMessageCount: vi.fn(),
  mockStoreMessage: vi.fn(),
  mockTouchChatSession: vi.fn(),
  mockUpdateChatSessionTitle: vi.fn(),
  mockDispatchAiChatPrompt: vi.fn(),
  mockCancelAiChatSessionRequest: vi.fn(),
  mockBuildStructuredInputForSession: vi.fn(),
  mockRedisDel: vi.fn(async () => 1),
  mockRedisEval: vi.fn(async () => 1),
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(async () => 'OK'),
}));

vi.mock('../../../src/infrastructure/db.js', () => ({
  archiveChatSession: mockArchiveChatSession,
  expireUserBonusBalanceBefore: vi.fn(async () => ({
    expired: 0,
    totalCoinsExpired: 0,
  })),
  getArchivedChatSessionsByUserId: mockGetArchivedChatSessionsByUserId,
  getChatSession: mockGetChatSession,
  getChatSessionPiSessionArchive: mockGetChatSessionPiSessionArchive,
  getRecentMessages: mockGetRecentMessages,
  getSessionMessageById: mockGetSessionMessageById,
  getSessionMessages: mockGetSessionMessages,
  getSessionMessagesWithToolContext: mockGetSessionMessagesWithToolContext,
  getSharedChatSessionByToken: mockGetSharedChatSessionByToken,
  getMembershipOverview: mockGetMembershipOverview,
  claimProfessionalAiTurn: mockClaimProfessionalAiTurn,
  releaseProfessionalAiTurn: mockReleaseProfessionalAiTurn,
  getUserById: mockGetUserById,
  getAccountsByUserId: mockGetAccountsByUserId,
  hasFinalAiChatSessionReply: mockHasFinalAiChatSessionReply,
  markChatSessionPiSessionArchived: mockMarkChatSessionPiSessionArchived,
  markChatSessionPiSessionArchiveRestored:
    mockMarkChatSessionPiSessionArchiveRestored,
  restoreArchivedChatSession: mockRestoreArchivedChatSession,
  shareOwnedChatSession: mockShareOwnedChatSession,
  storeMessage: mockStoreMessage,
  touchChatSession: mockTouchChatSession,
  getChatSessionsByUserId: vi.fn(),
  createChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  getConversationLogByRequestId: mockGetConversationLogByRequestId,
  updateChatSessionTitle: mockUpdateChatSessionTitle,
}));

vi.mock('../../../src/infrastructure/daily-usage.js', () => ({
  incrementDailyMessageCount: mockIncrementDailyMessageCount,
}));

vi.mock('../../../src/infrastructure/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/infrastructure/redis.js', () => ({
  getRedis: vi.fn(() => ({
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
    eval: mockRedisEval,
  })),
}));

vi.mock('../../../src/runtime/resident-agent.js', () => ({
  dispatchAiChatPrompt: mockDispatchAiChatPrompt,
}));

vi.mock('../../../src/runtime/ipc-worker.js', () => ({
  cancelAiChatSessionRequest: mockCancelAiChatSessionRequest,
}));

vi.mock('../../../src/modules/chat/structured-input.js', () => ({
  buildStructuredInputForSession: mockBuildStructuredInputForSession,
}));

vi.mock('../../../src/modules/chat/pi-session-files.js', () => ({
  deletePiSessionFilesForSession: mockDeletePiSessionFilesForSession,
  readPiSessionArchiveForSession: mockReadPiSessionArchiveForSession,
  readPiSessionFileState: mockReadPiSessionFileState,
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
  writePiSessionSnapshotArchiveToFiles:
    mockWritePiSessionSnapshotArchiveToFiles,
  writePiSessionArchiveToFiles: mockWritePiSessionArchiveToFiles,
}));

vi.mock('../../../src/modules/chat/paipan-runtime.js', () => ({
  isDirectPaipanSkill: vi.fn((skill: string) => skill === 'bazi-paipan'),
}));

vi.mock('../../../src/modules/system/system-config.js', () => ({
  resolveUserLlmRuntime: vi.fn(async () => ({
    source: 'custom',
    billingMode: 'none',
    modelConfigId: 'user-1',
    providerKey: 'custom:user-1',
    piApi: 'openai-completions',
    displayName: '自配模型',
    authMode: 'openai_api_key',
    secret: 'secret',
    secretSource: 'database',
    baseUrl: null,
    model: 'gpt-4.1',
    contextWindowTokens: 128_000,
    maxOutputTokens: 12_000,
    inputTokenPricePerMillionCoins: 0,
    outputTokenPricePerMillionCoins: 0,
  })),
}));

import {
  archiveOwnedChatSession,
  cancelOwnedChatSessionMessage,
  getSharedChatSessionByShareToken,
  listArchivedChatSessionsForOwnedUser,
  restoreOwnedArchivedChatSession,
  sendOwnedChatSessionMessage,
  shareOwnedChatSessionForUser,
} from '../../../src/modules/chat/chat-session-service.js';

describe('chat-session-service selected board context', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetChatSession.mockResolvedValue({
      id: 'session-1',
      account_id: 'web:user-1',
      user_id: 'user-1',
      title: '已有会话',
      created_at: '2026-04-26T09:00:00.000Z',
      updated_at: '2026-04-26T09:00:00.000Z',
      deleted_at: null,
    });
    mockGetUserById.mockResolvedValue({
      id: 'user-1',
      purchased_coins: 0,
      bonus_coins: 0,
      reserved_coins: 0,
    });
    mockGetMembershipOverview.mockResolvedValue({
      active: true,
      membership: { plan_key: 'fateclaw_deep' },
    });
    mockClaimProfessionalAiTurn.mockResolvedValue({
      allowed: true,
      usage_date: '2026-04-26',
      limit: 100,
      used: 1,
      remaining: 99,
    });
    mockReleaseProfessionalAiTurn.mockResolvedValue({
      released: true,
      usage_date: '2026-04-26',
      used: 0,
    });
    mockGetAccountsByUserId.mockResolvedValue([
      {
        id: 'account-1',
        user_id: 'wechat-user-1',
        name: '测试账号',
        bot_token: 'token',
        base_url: 'https://example.com',
        get_updates_buf: '',
        enabled: true,
        created_at: '2026-04-26T08:00:00.000Z',
        owner_id: 'user-1',
      },
    ]);
    mockStoreMessage.mockResolvedValue(undefined);
    mockTouchChatSession.mockResolvedValue(undefined);
    mockHasFinalAiChatSessionReply.mockResolvedValue(false);
    mockGetRecentMessages.mockResolvedValue([]);
    mockGetConversationLogByRequestId.mockResolvedValue(undefined);
    mockGetSessionMessages.mockResolvedValue([]);
    mockGetChatSessionPiSessionArchive.mockResolvedValue(undefined);
    mockReadPiSessionArchiveForSession.mockResolvedValue({
      sessionId: 'session-1',
      payload: {
        version: 1,
        mapping_file_name: 'session-1.path',
        mapping_content: 'session-1.jsonl',
        files: [
          {
            name: 'session-1.jsonl',
            content: '{"type":"session"}\n',
            size_bytes: 19,
            modified_at: '2026-04-26T09:00:00.000Z',
          },
        ],
        archived_at: '2026-04-26T09:10:00.000Z',
      },
      missingSessionFile: false,
      skippedUnsafeSessionFiles: [],
    });
    mockMarkChatSessionPiSessionArchived.mockResolvedValue(true);
    mockDeletePiSessionFilesForSession.mockResolvedValue({
      sessionId: 'session-1',
      deletedMappingFile: true,
      deletedSessionFiles: 1,
      missingSessionFile: false,
      skippedUnsafeSessionFiles: [],
    });
    mockWritePiSessionArchiveToFiles.mockResolvedValue({
      writtenSessionFiles: 1,
      writtenMappingFile: true,
    });
    mockWritePiSessionSnapshotArchiveToFiles.mockResolvedValue(null);
    mockMarkChatSessionPiSessionArchiveRestored.mockResolvedValue(undefined);
    mockReadPiSessionFileState.mockResolvedValue({
      hasSessionFile: true,
    });
    mockBuildStructuredInputForSession.mockResolvedValue({
      userMessage: '请解读这张盘',
      history: [
        {
          role: 'assistant',
          content: '之前的普通上下文',
        },
      ],
      userName: '测试账号',
      assistantName: '测试账号',
    });
    mockGetSessionMessageById.mockResolvedValue({
      id: 'board-msg-1',
      account_id: 'web:user-1',
      user_id: 'user-1',
      sender: 'web:user-1',
      sender_name: '命枢',
      content: '这是一张八字盘',
      timestamp: '2026-04-26T09:30:00.000Z',
      is_from_me: true,
      is_bot_message: true,
      session_id: 'session-1',
      tool_context: JSON.stringify([
        {
          skill: 'bazi-paipan',
          output: '八字排盘（系统排盘结果）\nbazi：true',
          artifactData: { bazi: true },
        },
      ]),
    });
    mockGetSessionMessagesWithToolContext.mockResolvedValue([
      {
        id: 'board-msg-1',
        account_id: 'web:user-1',
        user_id: 'user-1',
        sender: 'web:user-1',
        sender_name: '命枢',
        content: '这是一张八字盘',
        timestamp: '2026-04-26T09:30:00.000Z',
        is_from_me: true,
        is_bot_message: true,
        session_id: 'session-1',
        tool_context: JSON.stringify([
          {
            skill: 'bazi-paipan',
            output: '八字排盘（系统排盘结果）\nbazi：true',
            artifactTitle: '八字排盘',
            artifactData: { bazi: true },
          },
        ]),
      },
    ]);
    mockDispatchAiChatPrompt.mockResolvedValue({
      status: 'success',
      text: '好的，我来解读',
      requestId: 'request-1',
      metadata: null,
    });
    mockCancelAiChatSessionRequest.mockResolvedValue(true);
  });

  it('lists archived chat sessions for the owned user', async () => {
    mockGetArchivedChatSessionsByUserId.mockResolvedValueOnce([
      {
        id: 'session-archived',
        account_id: 'web:user-1',
        user_id: 'user-1',
        title: '旧会话',
        created_at: '2026-04-20T09:00:00.000Z',
        updated_at: '2026-04-21T09:00:00.000Z',
        deleted_at: '2026-04-26T09:00:00.000Z',
      },
    ]);

    const result = await listArchivedChatSessionsForOwnedUser('user-1');

    expect(result).toEqual({
      ok: true,
      data: [
        {
          id: 'session-archived',
          account_id: 'web:user-1',
          title: '旧会话',
          created_at: '2026-04-20T09:00:00.000Z',
          updated_at: '2026-04-21T09:00:00.000Z',
          share_token: null,
          deleted_at: '2026-04-26T09:00:00.000Z',
        },
      ],
    });
    expect(mockGetArchivedChatSessionsByUserId).toHaveBeenCalledWith('user-1');
  });

  it('archives the Pi session payload and deletes local files when archiving a chat session', async () => {
    const result = await archiveOwnedChatSession('user-1', 'session-1');

    expect(result).toEqual({
      ok: true,
      data: { success: true },
    });
    expect(mockReadPiSessionArchiveForSession).toHaveBeenCalledWith(
      'session-1',
    );
    expect(mockArchiveChatSession).toHaveBeenCalledWith('session-1');
    expect(mockMarkChatSessionPiSessionArchived).toHaveBeenCalledWith({
      sessionId: 'session-1',
      reason: 'soft_deleted',
      payload: expect.objectContaining({ version: 1 }),
    });
    expect(mockDeletePiSessionFilesForSession).toHaveBeenCalledWith(
      'session-1',
    );
  });

  it('restores an owned archived chat session', async () => {
    mockRestoreArchivedChatSession.mockResolvedValueOnce({
      id: 'session-archived',
      account_id: 'web:user-1',
      user_id: 'user-1',
      title: '旧会话',
      created_at: '2026-04-20T09:00:00.000Z',
      updated_at: '2026-04-26T09:30:00.000Z',
      deleted_at: null,
    });

    const result = await restoreOwnedArchivedChatSession(
      'user-1',
      'session-archived',
    );

    expect(result.ok).toBe(true);
    expect(mockRestoreArchivedChatSession).toHaveBeenCalledWith({
      userId: 'user-1',
      sessionId: 'session-archived',
    });
  });

  it('cancels the owned active AI chat request', async () => {
    const result = await cancelOwnedChatSessionMessage('user-1', 'session-1');

    expect(result).toEqual({
      ok: true,
      data: { success: true },
    });
    expect(mockCancelAiChatSessionRequest).toHaveBeenCalledWith(
      'session-1',
      'web:user-1',
    );
  });

  it('rejects Free professional AI turns because Free has no expert turns', async () => {
    mockGetMembershipOverview.mockResolvedValueOnce({ active: false });
    mockClaimProfessionalAiTurn.mockResolvedValueOnce({
      allowed: false,
      usage_date: '2026-04-26',
      limit: 0,
      used: 0,
      remaining: 0,
    });

    const result = await sendOwnedChatSessionMessage('user-1', 'session-1', {
      content: '请解读这张盘',
      inputKind: 'normal',
      pastedBoard: undefined,
    });

    expect(result).toEqual({
      ok: false,
      statusCode: 403,
      error: '今日专家模式 AI 次数已用完，请开通或升级 FateClaw 会员后继续。',
    });
    expect(mockClaimProfessionalAiTurn).toHaveBeenCalledWith({
      userId: 'user-1',
      dailyTurnLimit: 0,
    });
    expect(mockStoreMessage).not.toHaveBeenCalled();
    expect(mockRedisEval).toHaveBeenCalledTimes(2);
    expect(mockRedisEval).toHaveBeenLastCalledWith(
      expect.stringContaining("redis.call('DEL', KEYS[1])"),
      1,
      'session:processing:session-1',
      expect.stringMatching(/^aichat-/),
    );
    expect(mockDispatchAiChatPrompt).not.toHaveBeenCalled();
  });

  it('allows Clarity professional AI turns while daily turns remain and consumes one turn', async () => {
    mockGetMembershipOverview.mockResolvedValueOnce({
      active: true,
      membership: { plan_key: 'fateclaw_clarity' },
    });
    mockClaimProfessionalAiTurn.mockResolvedValueOnce({
      allowed: true,
      usage_date: '2026-04-26',
      limit: 10,
      used: 4,
      remaining: 6,
    });

    const result = await sendOwnedChatSessionMessage('user-1', 'session-1', {
      content: '请解读这张盘',
      inputKind: 'normal',
      pastedBoard: undefined,
    });

    expect(result.ok).toBe(true);
    expect(mockClaimProfessionalAiTurn).toHaveBeenCalledWith({
      userId: 'user-1',
      dailyTurnLimit: 10,
    });
    expect(mockStoreMessage).toHaveBeenCalled();
    expect(mockDispatchAiChatPrompt).toHaveBeenCalledTimes(1);
  });

  it('refunds a consumed Clarity professional AI turn when request preparation fails', async () => {
    mockGetMembershipOverview.mockResolvedValueOnce({
      active: true,
      membership: { plan_key: 'fateclaw_clarity' },
    });
    mockClaimProfessionalAiTurn.mockResolvedValueOnce({
      allowed: true,
      usage_date: '2026-04-26',
      limit: 10,
      used: 4,
      remaining: 6,
    });
    mockBuildStructuredInputForSession.mockRejectedValueOnce(
      new Error('structured input unavailable'),
    );

    const result = await sendOwnedChatSessionMessage('user-1', 'session-1', {
      content: '请解读这张盘',
      inputKind: 'normal',
      pastedBoard: undefined,
    });

    expect(result).toEqual({
      ok: false,
      statusCode: 502,
      error: 'structured input unavailable',
    });
    expect(mockReleaseProfessionalAiTurn).toHaveBeenCalledWith({
      userId: 'user-1',
      usageDate: '2026-04-26',
    });
    expect(mockDispatchAiChatPrompt).not.toHaveBeenCalled();
  });

  it('refunds a consumed Clarity professional AI turn when enqueueing fails', async () => {
    mockGetMembershipOverview.mockResolvedValueOnce({
      active: true,
      membership: { plan_key: 'fateclaw_clarity' },
    });
    mockClaimProfessionalAiTurn.mockResolvedValueOnce({
      allowed: true,
      usage_date: '2026-04-26',
      limit: 10,
      used: 4,
      remaining: 6,
    });
    mockDispatchAiChatPrompt.mockResolvedValueOnce({
      status: 'error',
      publicErrorText: 'AI 处理失败',
      text: '',
      error: 'runtime unavailable',
    });

    const result = await sendOwnedChatSessionMessage('user-1', 'session-1', {
      content: '请解读这张盘',
      inputKind: 'normal',
      pastedBoard: undefined,
    });

    expect(result).toEqual({
      ok: false,
      statusCode: 502,
      error: 'AI 处理失败',
    });
    expect(mockStoreMessage).toHaveBeenCalled();
    expect(mockReleaseProfessionalAiTurn).toHaveBeenCalledWith({
      userId: 'user-1',
      usageDate: '2026-04-26',
    });
  });

  it('consumes Deep professional AI turns with the Deep daily limit', async () => {
    await sendOwnedChatSessionMessage('user-1', 'session-1', {
      content: '请解读这张盘',
      inputKind: 'normal',
      pastedBoard: undefined,
    });

    expect(mockClaimProfessionalAiTurn).toHaveBeenCalledWith({
      userId: 'user-1',
      dailyTurnLimit: 100,
    });
    expect(mockDispatchAiChatPrompt).toHaveBeenCalledTimes(1);
  });

  it('does not consume professional AI turns for simple workflow first-turn bypass', async () => {
    mockGetMembershipOverview.mockResolvedValueOnce({ active: false });

    const result = await sendOwnedChatSessionMessage(
      'user-1',
      'session-1',
      {
        content: '简易模式首轮',
        inputKind: 'normal',
        pastedBoard: undefined,
      },
      {
        professionalAiQuotaBypass: 'simple_workflow_first_turn',
      },
    );

    expect(result.ok).toBe(true);
    expect(mockClaimProfessionalAiTurn).not.toHaveBeenCalled();
    expect(mockDispatchAiChatPrompt).toHaveBeenCalledTimes(1);
  });

  it('passes all session boards and only uses selected id for current marking', async () => {
    const result = await sendOwnedChatSessionMessage('user-1', 'session-1', {
      content: '请解读这张盘',
      selectedBoardMessageId: 'board-msg-1',
      inputKind: 'normal',
      pastedBoard: undefined,
    });

    expect(result.ok).toBe(true);
    expect(mockDispatchAiChatPrompt).toHaveBeenCalledTimes(1);
    const claimCall = mockRedisEval.mock.calls[0] as unknown[] | undefined;
    const claimRequestId = claimCall?.[3];
    expect(claimRequestId).toEqual(expect.stringMatching(/^aichat-/));
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('SET', KEYS[1], ARGV[1]"),
      1,
      'session:processing:session-1',
      claimRequestId,
      2100,
    );
    expect(mockDispatchAiChatPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'web:user-1',
        requestId: claimRequestId,
        sessionBoardContexts: [
          {
            sourceMessageId: 'board-msg-1',
            source: 'official_paipan',
            skill: 'bazi-paipan',
            artifactTitle: '八字排盘',
            promptText: '八字排盘（系统排盘结果）\nbazi：true',
            artifactData: { bazi: true },
            createdAt: '2026-04-26T09:30:00.000Z',
            isCurrent: true,
          },
        ],
        history: [],
      }),
    );
  });

  it('wraps the first normal question after a board insert for the runtime only', async () => {
    mockGetSessionMessages.mockResolvedValueOnce([
      {
        id: 'board-msg-1',
        account_id: 'web:user-1',
        user_id: 'user-1',
        sender: 'web:user-1',
        sender_name: '命枢',
        content:
          '已生成八字排盘。你可以直接提问，后续未切换主题时会参考此盘面。',
        timestamp: '2026-04-26T09:30:00.000Z',
        is_from_me: true,
        is_bot_message: true,
        session_id: 'session-1',
        tool_context: JSON.stringify([
          {
            skill: 'bazi-paipan',
            output: '八字排盘（系统排盘结果）\nbazi：true',
            artifactTitle: '八字排盘',
            artifactData: { bazi: true },
          },
        ]),
        metadata: {
          kind: 'board_result',
          workflow: 'direct_paipan',
          board_skill: 'bazi-paipan',
        },
      },
    ]);
    mockBuildStructuredInputForSession.mockImplementationOnce(
      async (_identity, userMessage: string) => ({
        userMessage,
        history: [],
        userName: '测试账号',
        assistantName: '测试账号',
      }),
    );

    const result = await sendOwnedChatSessionMessage('user-1', 'session-1', {
      content: '看看事业',
      selectedBoardMessageId: undefined,
      inputKind: 'normal',
      pastedBoard: undefined,
    });

    expect(result.ok).toBe(true);
    expect(mockBuildStructuredInputForSession).toHaveBeenCalledWith(
      expect.any(Object),
      [
        '已生成八字排盘。你可以直接提问，后续未切换主题时会参考此盘面。',
        '',
        '【用户发送的问题】',
        '看看事业',
      ].join('\n'),
      'session-1',
      'gpt-4.1',
      128_000,
    );
    expect(mockStoreMessage.mock.calls[0]?.[0]).toMatchObject({
      content: '看看事业',
      is_bot_message: false,
    });
    expect(mockDispatchAiChatPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: [
          '已生成八字排盘。你可以直接提问，后续未切换主题时会参考此盘面。',
          '',
          '【用户发送的问题】',
          '看看事业',
        ].join('\n'),
      }),
    );
  });

  it('does not wrap later normal questions after a final reply already followed the board', async () => {
    mockGetSessionMessages.mockResolvedValueOnce([
      {
        id: 'board-msg-1',
        account_id: 'web:user-1',
        user_id: 'user-1',
        sender: 'web:user-1',
        sender_name: '命枢',
        content:
          '已生成八字排盘。你可以直接提问，后续未切换主题时会参考此盘面。',
        timestamp: '2026-04-26T09:30:00.000Z',
        is_from_me: true,
        is_bot_message: true,
        session_id: 'session-1',
        tool_context: JSON.stringify([
          {
            skill: 'bazi-paipan',
            output: '八字排盘（系统排盘结果）\nbazi：true',
            artifactTitle: '八字排盘',
            artifactData: { bazi: true },
          },
        ]),
        metadata: {
          kind: 'board_result',
          workflow: 'direct_paipan',
          board_skill: 'bazi-paipan',
        },
      },
      {
        id: 'aichat-existing_reply',
        account_id: 'web:user-1',
        user_id: 'user-1',
        sender: 'web:user-1',
        sender_name: '命枢',
        content: '之前已经基于盘面回复过一次',
        timestamp: '2026-04-26T09:31:00.000Z',
        is_from_me: true,
        is_bot_message: true,
        session_id: 'session-1',
        metadata: {
          kind: 'final',
          turn_complete: true,
        },
      },
    ]);
    mockBuildStructuredInputForSession.mockImplementationOnce(
      async (_identity, userMessage: string) => ({
        userMessage,
        history: [],
        userName: '测试账号',
        assistantName: '测试账号',
      }),
    );

    const result = await sendOwnedChatSessionMessage('user-1', 'session-1', {
      content: '今天聊点别的',
      selectedBoardMessageId: undefined,
      inputKind: 'normal',
      pastedBoard: undefined,
    });

    expect(result.ok).toBe(true);
    expect(mockBuildStructuredInputForSession).toHaveBeenCalledWith(
      expect.any(Object),
      '今天聊点别的',
      'session-1',
      'gpt-4.1',
      128_000,
    );
  });

  it('blocks sending when the user is already in arrears', async () => {
    mockGetUserById.mockResolvedValueOnce({
      id: 'user-1',
      purchased_coins: -1,
      bonus_coins: 0,
      reserved_coins: 0,
    });

    const result = await sendOwnedChatSessionMessage('user-1', 'session-1', {
      content: '继续分析',
      selectedBoardMessageId: undefined,
      inputKind: 'normal',
      pastedBoard: undefined,
    });

    expect(result).toEqual({
      ok: false,
      statusCode: 402,
      error: '积分已欠费，请补充积分后继续使用',
    });
    expect(mockDispatchAiChatPrompt).not.toHaveBeenCalled();
  });

  it('blocks continuation when a real AI session lost its Pi jsonl file', async () => {
    mockHasFinalAiChatSessionReply.mockResolvedValueOnce(true);
    mockReadPiSessionFileState.mockResolvedValueOnce({
      hasSessionFile: false,
    });

    const result = await sendOwnedChatSessionMessage('user-1', 'session-1', {
      content: '继续分析',
      selectedBoardMessageId: undefined,
      inputKind: 'normal',
      pastedBoard: undefined,
    });

    expect(result).toEqual({
      ok: false,
      statusCode: 410,
      error: '此对话长期未活跃，历史上下文已归档，不支持继续追问。请新建对话。',
    });
    expect(mockStoreMessage).not.toHaveBeenCalled();
    expect(mockDispatchAiChatPrompt).not.toHaveBeenCalled();
  });

  it('restores archived Pi jsonl from database before continuing', async () => {
    mockHasFinalAiChatSessionReply.mockResolvedValueOnce(true);
    mockReadPiSessionFileState
      .mockResolvedValueOnce({ hasSessionFile: false })
      .mockResolvedValueOnce({ hasSessionFile: true });
    mockGetChatSessionPiSessionArchive.mockResolvedValueOnce({
      id: 'session-1',
      pi_session_archived_at: '2026-04-26T10:00:00.000Z',
      pi_session_archive_reason: 'inactive',
      pi_session_archive_payload: {
        version: 1,
        mapping_file_name: 'session-1.path',
        mapping_content: 'session-1.jsonl',
        files: [
          {
            name: 'session-1.jsonl',
            content: '{"type":"turn"}\n',
            size_bytes: 16,
            modified_at: '2026-04-26T09:00:00.000Z',
          },
        ],
        archived_at: '2026-04-26T10:00:00.000Z',
      },
      pi_session_archive_restored_at: null,
    });

    const result = await sendOwnedChatSessionMessage('user-1', 'session-1', {
      content: '继续分析',
      selectedBoardMessageId: undefined,
      inputKind: 'normal',
      pastedBoard: undefined,
    });

    expect(result.ok).toBe(true);
    expect(mockWritePiSessionArchiveToFiles).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ version: 1 }),
    );
    expect(mockMarkChatSessionPiSessionArchiveRestored).toHaveBeenCalledWith(
      'session-1',
    );
    expect(mockDispatchAiChatPrompt).toHaveBeenCalledTimes(1);
  });

  it('rebuilds Pi jsonl from conversation log snapshot before continuing', async () => {
    mockHasFinalAiChatSessionReply.mockResolvedValueOnce(true);
    mockReadPiSessionFileState
      .mockResolvedValueOnce({ hasSessionFile: false })
      .mockResolvedValueOnce({ hasSessionFile: true });
    mockGetRecentMessages.mockResolvedValueOnce([
      {
        id: 'aichat-reply-1',
        account_id: 'web:user-1',
        sender: 'assistant',
        sender_name: '命枢',
        content: '已有回复',
        timestamp: '2026-04-26T09:20:00.000Z',
        is_from_me: false,
        is_bot_message: true,
        session_id: 'session-1',
        metadata: {
          kind: 'final',
          request_id: 'request-1',
        },
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
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: '继续分析' }],
                timestamp: 1780145082878,
              },
              {
                role: 'assistant',
                content: [{ type: 'text', text: '可以' }],
                provider: 'openai-completions',
                model: 'gpt-4.1',
                stopReason: 'stop',
                timestamp: 1780145083878,
              },
            ],
          },
        },
      ],
      agent_graph: null,
      agent_graph_summary: null,
      capability_ledger: null,
      created_at: '2026-04-26T09:20:00.000Z',
    });
    mockWritePiSessionSnapshotArchiveToFiles.mockResolvedValueOnce({
      payload: {
        version: 1,
        mapping_file_name: 'session-1.path',
        mapping_content: '2026-04-26T09-20-00-000Z_session-1.jsonl',
        files: [
          {
            name: '2026-04-26T09-20-00-000Z_session-1.jsonl',
            content: '{"type":"session"}\n',
            size_bytes: 19,
            modified_at: '2026-04-26T09:20:00.000Z',
          },
        ],
        archived_at: '2026-04-26T09:20:00.000Z',
      },
      writtenSessionFiles: 1,
      writtenMappingFile: true,
      snapshotMessageCount: 2,
    });

    const result = await sendOwnedChatSessionMessage('user-1', 'session-1', {
      content: '继续分析',
      selectedBoardMessageId: undefined,
      inputKind: 'normal',
      pastedBoard: undefined,
    });

    expect(result.ok).toBe(true);
    expect(mockGetConversationLogByRequestId).toHaveBeenCalledWith('request-1');
    expect(mockWritePiSessionSnapshotArchiveToFiles).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ model: 'gpt-4.1' }),
    );
    expect(mockMarkChatSessionPiSessionArchived).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        reason: 'inactive',
      }),
    );
    expect(mockMarkChatSessionPiSessionArchiveRestored).toHaveBeenCalledWith(
      'session-1',
    );
    expect(mockDispatchAiChatPrompt).toHaveBeenCalledTimes(1);
  });

  it('creates a share link for owned sessions', async () => {
    mockShareOwnedChatSession.mockResolvedValueOnce({
      id: 'session-1',
      account_id: 'web:user-1',
      user_id: 'user-1',
      title: '已有会话',
      share_token: 'share-token',
      share_created_at: '2026-04-26T10:00:00.000Z',
      created_at: '2026-04-26T09:00:00.000Z',
      updated_at: '2026-04-26T09:00:00.000Z',
      deleted_at: null,
    });

    const result = await shareOwnedChatSessionForUser('user-1', 'session-1');

    expect(result).toMatchObject({
      ok: true,
      data: {
        share_token: 'share-token',
        share_url_path: '/ai-chat/share?token=share-token',
        session: {
          id: 'session-1',
          share_token: 'share-token',
        },
      },
    });
    expect(mockShareOwnedChatSession).toHaveBeenCalledWith({
      userId: 'user-1',
      sessionId: 'session-1',
      shareToken: expect.any(String),
    });
  });

  it('loads shared sessions by token without auth ownership checks', async () => {
    mockGetSharedChatSessionByToken.mockResolvedValueOnce({
      id: 'session-1',
      account_id: 'web:user-1',
      user_id: 'user-1',
      title: '已有会话',
      share_token: 'share-token',
      share_created_at: '2026-04-26T10:00:00.000Z',
      created_at: '2026-04-26T09:00:00.000Z',
      updated_at: '2026-04-26T09:00:00.000Z',
      deleted_at: null,
    });
    mockGetSessionMessages.mockResolvedValueOnce([
      {
        id: 'message-1',
        account_id: 'web:user-1',
        sender: 'user-1',
        sender_name: '用户',
        content: '你好',
        timestamp: '2026-04-26T09:01:00.000Z',
        is_from_me: false,
        is_bot_message: false,
        session_id: 'session-1',
      },
    ]);

    const result = await getSharedChatSessionByShareToken('share-token');

    expect(result).toMatchObject({
      ok: true,
      data: {
        id: 'session-1',
        title: '已有会话',
        messages: [{ id: 'message-1', content: '你好' }],
      },
    });
    expect(mockGetChatSession).not.toHaveBeenCalled();
    expect(mockGetSessionMessages).toHaveBeenCalledWith(
      'web:user-1',
      'session-1',
    );
  });

  it('keeps placeholder titles unified without auto-generating a summary title', async () => {
    mockGetChatSession.mockResolvedValueOnce({
      id: 'session-2',
      account_id: 'web:user-1',
      user_id: 'user-1',
      title: '新对话',
      created_at: '2026-04-26T09:00:00.000Z',
      updated_at: '2026-04-26T09:00:00.000Z',
      deleted_at: null,
    });

    const result = await sendOwnedChatSessionMessage('user-1', 'session-2', {
      content: '帮我看看最近事业运',
      selectedBoardMessageId: undefined,
      inputKind: 'normal',
      pastedBoard: undefined,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.session_title).toBe('未设置标题');
    }
    expect(mockUpdateChatSessionTitle).not.toHaveBeenCalled();
  });

  it('acknowledges async sends without storing final assistant messages in service', async () => {
    mockDispatchAiChatPrompt.mockResolvedValueOnce({
      status: 'success',
      text: '',
      requestId: 'request-multi',
    });

    const result = await sendOwnedChatSessionMessage('user-1', 'session-1', {
      content: '请分两条回复',
      selectedBoardMessageId: undefined,
      inputKind: 'normal',
      pastedBoard: undefined,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        text: '',
        accepted: true,
        request_id: 'request-multi',
      });
    }
    const storedBotMessages = mockStoreMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.is_bot_message);
    expect(storedBotMessages).toHaveLength(0);
    expect(mockDispatchAiChatPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        waitForResponse: false,
        userMessageId: expect.stringMatching(/^aichat-/),
      }),
    );
  });

  it('uses the owned WeChat account as the Soul source for web AI chat', async () => {
    const result = await sendOwnedChatSessionMessage('user-1', 'session-1', {
      content: '继续分析事业',
      selectedBoardMessageId: undefined,
      inputKind: 'normal',
      pastedBoard: undefined,
    });

    expect(result.ok).toBe(true);
    expect(mockBuildStructuredInputForSession).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: 'web:user-1',
        soulAccountId: 'account-1',
      }),
      '继续分析事业',
      'session-1',
      'gpt-4.1',
      128_000,
    );
  });

  it('defaults the current board to the newest valid board when no board is selected', async () => {
    mockGetSessionMessagesWithToolContext.mockResolvedValueOnce([
      {
        id: 'older-board',
        account_id: 'web:user-1',
        user_id: 'user-1',
        sender: 'web:user-1',
        sender_name: '命枢',
        content: '旧盘',
        timestamp: '2026-04-26T09:30:00.000Z',
        is_from_me: true,
        is_bot_message: true,
        session_id: 'session-1',
        tool_context: JSON.stringify([
          {
            skill: 'bazi-paipan',
            output: '八字排盘（系统排盘结果）\n旧盘',
            artifactTitle: '八字排盘',
            artifactData: { oldBoard: true },
          },
        ]),
      },
      {
        id: 'newer-board',
        account_id: 'web:user-1',
        user_id: 'user-1',
        sender: 'web:user-1',
        sender_name: '命枢',
        content: '新盘',
        timestamp: '2026-04-26T10:30:00.000Z',
        is_from_me: true,
        is_bot_message: true,
        session_id: 'session-1',
        tool_context: JSON.stringify([
          {
            skill: 'bazi-paipan',
            output: '八字排盘（系统排盘结果）\n新盘',
            artifactTitle: '八字排盘',
            artifactData: { newerBoard: true },
          },
        ]),
      },
    ]);

    const result = await sendOwnedChatSessionMessage('user-1', 'session-1', {
      content: '继续分析',
      selectedBoardMessageId: undefined,
      inputKind: 'normal',
      pastedBoard: undefined,
    });

    expect(result.ok).toBe(true);
    expect(mockDispatchAiChatPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionBoardContexts: [
          expect.objectContaining({
            sourceMessageId: 'newer-board',
            isCurrent: true,
          }),
          expect.objectContaining({
            sourceMessageId: 'older-board',
            isCurrent: false,
          }),
        ],
      }),
    );
  });
});
