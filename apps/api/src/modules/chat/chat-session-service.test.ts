import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetChatSession,
  mockGetSessionMessageById,
  mockGetSessionMessagesWithToolContext,
  mockGetUserById,
  mockGetAccountsByUserId,
  mockIncrementDailyMessageCount,
  mockStoreMessage,
  mockTouchChatSession,
  mockUpdateChatSessionTitle,
  mockDispatchAiChatPrompt,
  mockBuildStructuredInputForSession,
} = vi.hoisted(() => ({
  mockGetChatSession: vi.fn(),
  mockGetSessionMessageById: vi.fn(),
  mockGetSessionMessagesWithToolContext: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetAccountsByUserId: vi.fn(),
  mockIncrementDailyMessageCount: vi.fn(),
  mockStoreMessage: vi.fn(),
  mockTouchChatSession: vi.fn(),
  mockUpdateChatSessionTitle: vi.fn(),
  mockDispatchAiChatPrompt: vi.fn(),
  mockBuildStructuredInputForSession: vi.fn(),
}));

vi.mock('../../infrastructure/db.js', () => ({
  getChatSession: mockGetChatSession,
  getSessionMessageById: mockGetSessionMessageById,
  getSessionMessagesWithToolContext: mockGetSessionMessagesWithToolContext,
  getUserById: mockGetUserById,
  getAccountsByUserId: mockGetAccountsByUserId,
  storeMessage: mockStoreMessage,
  touchChatSession: mockTouchChatSession,
  getChatSessionsByUserId: vi.fn(),
  createChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  getConversationLogByRequestId: vi.fn(),
  getRecentMessages: vi.fn(),
  updateChatSessionTitle: mockUpdateChatSessionTitle,
}));

vi.mock('../../infrastructure/daily-usage.js', () => ({
  incrementDailyMessageCount: mockIncrementDailyMessageCount,
}));

vi.mock('../../infrastructure/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../infrastructure/redis.js', () => ({
  getRedis: vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
  })),
}));

vi.mock('../../runtime/resident-agent.js', () => ({
  dispatchAiChatPrompt: mockDispatchAiChatPrompt,
}));

vi.mock('./message-handler.js', () => ({
  buildStructuredInputForSession: mockBuildStructuredInputForSession,
}));

vi.mock('./paipan-runtime.js', () => ({
  isDirectPaipanSkill: vi.fn((skill: string) => skill === 'bazi-paipan'),
}));

vi.mock('../system/system-config.js', () => ({
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
    inputTokenPricePerMillionPoints: 0,
    outputTokenPricePerMillionPoints: 0,
  })),
}));

import { sendOwnedChatSessionMessage } from './chat-session-service.js';

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
    mockGetUserById.mockResolvedValue({ id: 'user-1' });
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
    expect(mockDispatchAiChatPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'web:user-1',
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

  it('stores every assistant message returned by the runtime', async () => {
    mockDispatchAiChatPrompt.mockResolvedValueOnce({
      status: 'success',
      text: '第二条回复\n\n📥 3 · 📤 5 Finished',
      assistantMessages: [
        '第一条回复',
        '第二条回复\n\n📥 3 · 📤 5 Finished',
      ],
      requestId: 'request-multi',
      metadata: { kind: 'final', turn_complete: true },
    });

    const result = await sendOwnedChatSessionMessage('user-1', 'session-1', {
      content: '请分两条回复',
      selectedBoardMessageId: undefined,
      inputKind: 'normal',
      pastedBoard: undefined,
    });

    expect(result.ok).toBe(true);
    const storedBotMessages = mockStoreMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.is_bot_message);
    expect(storedBotMessages).toHaveLength(2);
    expect(storedBotMessages[0]).toMatchObject({
      content: '第一条回复',
      metadata: {
        kind: 'assistant',
        request_id: 'request-multi',
      },
      tool_context: null,
    });
    expect(storedBotMessages[1]).toMatchObject({
      content: '第二条回复\n\n📥 3 · 📤 5 Finished',
      metadata: {
        kind: 'final',
        turn_complete: true,
        request_id: 'request-multi',
      },
    });
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
