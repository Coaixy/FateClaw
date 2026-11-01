import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateChatSessionForOwnedUser,
  mockDeleteWechatChatSessionLink,
  mockGetRedisGet,
  mockGetRedisSet,
  mockGetWechatChatSessionLink,
  mockRunOwnedChatSessionTurn,
  mockTouchWechatChatSessionLink,
  mockUpsertWechatChatSessionLink,
  mockEnsureActor,
  mockAccessibleSession,
  mockAccessibleSessions,
} = vi.hoisted(() => ({
  mockCreateChatSessionForOwnedUser: vi.fn(),
  mockDeleteWechatChatSessionLink: vi.fn(),
  mockGetRedisGet: vi.fn(),
  mockGetRedisSet: vi.fn(async () => 'OK'),
  mockGetWechatChatSessionLink: vi.fn(),
  mockRunOwnedChatSessionTurn: vi.fn(),
  mockTouchWechatChatSessionLink: vi.fn(),
  mockUpsertWechatChatSessionLink: vi.fn(),
  mockEnsureActor: vi.fn(),
  mockAccessibleSession: vi.fn(),
  mockAccessibleSessions: vi.fn(),
}));

vi.mock('#modules/chat/chat-session-service', () => ({
  createChatSessionForOwnedUser: mockCreateChatSessionForOwnedUser,
  runOwnedChatSessionTurn: mockRunOwnedChatSessionTurn,
}));

vi.mock('#infrastructure/db', () => ({
  deleteWechatChatSessionLink: mockDeleteWechatChatSessionLink,
  getWechatChatSessionLink: mockGetWechatChatSessionLink,
  touchWechatChatSessionLink: mockTouchWechatChatSessionLink,
  upsertWechatChatSessionLink: mockUpsertWechatChatSessionLink,
}));

vi.mock('#infrastructure/redis', () => ({
  getRedis: vi.fn(() => ({
    get: mockGetRedisGet,
    set: mockGetRedisSet,
  })),
}));

vi.mock('#infrastructure/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock('#modules/chat/wechat-session-access', () => ({
  ensureWechatSessionActor: mockEnsureActor,
  getWechatAccessibleSession: mockAccessibleSession,
  listWechatAccessibleSessions: mockAccessibleSessions,
}));

import {
  buildWechatSenderHash,
  handleWechatChatCommand,
  runWechatChatSessionTurn,
} from '#modules/chat/wechat-chat-session-service';
import type { Account } from '#shared/types';

function createAccount(): Account {
  return {
    id: 'bot-1@im.bot',
    user_id: 'bot-owner@im.weixin',
    name: '命枢',
    bot_token: 'token',
    base_url: 'https://ilink.example',
    get_updates_buf: '',
    enabled: true,
    created_at: '2026-06-03T00:00:00.000Z',
    owner_id: 'user-1',
  };
}

function createSession(id = 'session-1') {
  return {
    id,
    account_id: 'web:user-1',
    user_id: 'user-1',
    title: '事业复盘',
    created_at: '2026-06-03T07:00:00.000Z',
    updated_at: '2026-06-03T08:00:00.000Z',
    deleted_at: null,
  };
}

describe('wechat-chat-session-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRedisGet.mockResolvedValue(null);
    mockAccessibleSession.mockResolvedValue(createSession());
    mockAccessibleSessions.mockResolvedValue([createSession()]);
    mockEnsureActor.mockImplementation(async ({ accountId, senderHash }) => ({
      actorKey: `wechat:${accountId}:${senderHash}`,
    }));
    mockGetWechatChatSessionLink.mockResolvedValue(undefined);
    mockCreateChatSessionForOwnedUser.mockResolvedValue({
      ok: true,
      data: {
        id: 'session-new',
        account_id: 'web:user-1',
        title: '微信对话',
        created_at: '2026-06-03T08:00:00.000Z',
        updated_at: '2026-06-03T08:00:00.000Z',
        share_token: null,
      },
    });
    mockRunOwnedChatSessionTurn.mockResolvedValue({
      ok: true,
      data: {
        response: { text: '最终回复' },
        finalAssistantMessages: [
          {
            id: 'assistant-1',
            account_id: 'web:user-1',
            sender: 'web:user-1',
            sender_name: '命枢',
            content: '最终回复',
            timestamp: '2026-06-03T08:00:01.000Z',
            is_from_me: true,
            is_bot_message: true,
            metadata: { kind: 'final' },
            tool_context: null,
          },
        ],
      },
    });
  });

  it('lists authorized web sessions and caches resume choices for an explicitly shared owner', async () => {
    const account = createAccount();
    const result = await handleWechatChatCommand({
      account,
      owner: { id: 'user-1' },
      sender: 'sender-1@im.weixin',
      content: '/sessions',
    });

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('事业复盘');
    expect(mockGetRedisSet).toHaveBeenCalledWith(
      expect.stringContaining(
        buildWechatSenderHash(account.id, 'sender-1@im.weixin'),
      ),
      JSON.stringify(['session-1']),
      'EX',
      600,
    );
  });

  it('resumes a cached session choice for the sender', async () => {
    const account = createAccount();
    const sender = 'sender-1@im.weixin';
    mockGetRedisGet.mockResolvedValue(JSON.stringify(['session-1']));

    const result = await handleWechatChatCommand({
      account,
      owner: { id: 'user-1' },
      sender,
      content: '/resume 1',
    });

    expect(result.replyText).toContain('事业复盘');
    expect(mockUpsertWechatChatSessionLink).toHaveBeenCalledWith({
      accountId: account.id,
      senderHash: buildWechatSenderHash(account.id, sender),
      userId: 'user-1',
      sessionId: 'session-1',
    });
  });

  it('auto-creates a web session for an unlinked normal wechat message', async () => {
    const account = createAccount();
    const sender = 'sender-1@im.weixin';
    const onAccepted = vi.fn(async () => undefined);

    const result = await runWechatChatSessionTurn({
      account,
      owner: { id: 'user-1' },
      sender,
      messageId: '123',
      content: '你好',
      onAccepted,
    });

    expect(result.status).toBe('completed');
    expect(result.finalAssistantMessages?.[0]?.content).toBe('最终回复');
    expect(mockCreateChatSessionForOwnedUser).toHaveBeenCalledWith(
      'user-1',
      '微信对话',
      `wechat:${account.id}:${buildWechatSenderHash(account.id, sender)}`,
    );
    expect(mockRunOwnedChatSessionTurn).toHaveBeenCalledWith(
      'user-1',
      'session-new',
      expect.objectContaining({ content: '你好', inputKind: 'normal' }),
      expect.objectContaining({
        userMessageId: expect.stringMatching(/^wxmsg-[a-f0-9]{32}$/),
        sourceMetadata: expect.objectContaining({
          source_channel: 'wechat',
          wechat_account_id: account.id,
          sender_hash: buildWechatSenderHash(account.id, sender),
        }),
        onProcessingClaimed: onAccepted,
      }),
    );
  });

  it('discards normal messages while the linked web session is processing', async () => {
    const account = createAccount();
    const sender = 'sender-1@im.weixin';
    mockGetWechatChatSessionLink.mockResolvedValue({
      account_id: account.id,
      sender_hash: buildWechatSenderHash(account.id, sender),
      user_id: 'user-1',
      session_id: 'session-1',
      created_at: '2026-06-03T08:00:00.000Z',
      updated_at: '2026-06-03T08:00:00.000Z',
      last_used_at: '2026-06-03T08:00:00.000Z',
    });
    mockGetRedisGet.mockResolvedValue('aichat-request-1');

    const result = await runWechatChatSessionTurn({
      account,
      owner: { id: 'user-1' },
      sender,
      messageId: '124',
      content: '第二条',
    });

    expect(result.status).toBe('discarded');
    expect(mockRunOwnedChatSessionTurn).not.toHaveBeenCalled();
    expect(mockTouchWechatChatSessionLink).not.toHaveBeenCalled();
  });

  it('does not disclose owner titles to a sender without authorized sessions', async () => {
    mockAccessibleSessions.mockResolvedValueOnce([]);
    const result = await handleWechatChatCommand({
      account: createAccount(),
      owner: { id: 'user-1' },
      sender: 'unknown-sender',
      content: '/sessions',
    });
    expect(result.replyText).not.toContain('事业复盘');
    expect(result.replyText).toContain('/new');
    expect(result.replyText).toContain('/memory');
    expect(mockGetRedisSet).toHaveBeenCalledWith(
      expect.any(String),
      '[]',
      'EX',
      600,
    );
  });

  it('rechecks cached resume targets after owner sharing is revoked', async () => {
    mockGetRedisGet.mockResolvedValueOnce(JSON.stringify(['session-1']));
    mockAccessibleSession.mockResolvedValueOnce(null);
    const result = await handleWechatChatCommand({
      account: createAccount(),
      owner: { id: 'user-1' },
      sender: 'sender-1@im.weixin',
      content: '/resume 1',
    });
    expect(result.replyText).not.toContain('事业复盘');
    expect(result.replyText).toContain('/memory');
    expect(mockUpsertWechatChatSessionLink).not.toHaveBeenCalled();
  });

  it('uses the actor-safe title for where and records the server actor on explicit new sessions', async () => {
    const account = createAccount();
    const sender = 'sender-1@im.weixin';
    mockGetWechatChatSessionLink.mockResolvedValueOnce({
      session_id: 'session-1',
    });
    mockAccessibleSession.mockResolvedValueOnce({
      ...createSession(),
      title: '本人原始标题',
    });
    const where = await handleWechatChatCommand({
      account,
      owner: { id: 'user-1' },
      sender,
      content: '/where',
    });
    expect(where.replyText).toBe('当前接续：本人原始标题');
    expect(where.replyText).not.toContain('事业复盘');
    await handleWechatChatCommand({
      account,
      owner: { id: 'user-1' },
      sender,
      content: '/new 本人新对话',
    });
    expect(mockCreateChatSessionForOwnedUser).toHaveBeenCalledWith(
      'user-1',
      '本人新对话',
      `wechat:${account.id}:${buildWechatSenderHash(account.id, sender)}`,
    );
  });
});
