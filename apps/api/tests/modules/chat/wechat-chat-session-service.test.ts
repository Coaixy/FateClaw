import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateChatSessionForOwnedUser,
  mockDeleteWechatChatSessionLink,
  mockGetChatSession,
  mockGetRedisGet,
  mockGetRedisSet,
  mockGetWechatChatSessionLink,
  mockListChatSessionsForOwnedUser,
  mockRunOwnedChatSessionTurn,
  mockTouchWechatChatSessionLink,
  mockUpsertWechatChatSessionLink,
} = vi.hoisted(() => ({
  mockCreateChatSessionForOwnedUser: vi.fn(),
  mockDeleteWechatChatSessionLink: vi.fn(),
  mockGetChatSession: vi.fn(),
  mockGetRedisGet: vi.fn(),
  mockGetRedisSet: vi.fn(async () => 'OK'),
  mockGetWechatChatSessionLink: vi.fn(),
  mockListChatSessionsForOwnedUser: vi.fn(),
  mockRunOwnedChatSessionTurn: vi.fn(),
  mockTouchWechatChatSessionLink: vi.fn(),
  mockUpsertWechatChatSessionLink: vi.fn(),
}));

vi.mock('../../../src/modules/chat/chat-session-service.js', () => ({
  createChatSessionForOwnedUser: mockCreateChatSessionForOwnedUser,
  listChatSessionsForOwnedUser: mockListChatSessionsForOwnedUser,
  runOwnedChatSessionTurn: mockRunOwnedChatSessionTurn,
}));

vi.mock('../../../src/infrastructure/db.js', () => ({
  deleteWechatChatSessionLink: mockDeleteWechatChatSessionLink,
  getChatSession: mockGetChatSession,
  getWechatChatSessionLink: mockGetWechatChatSessionLink,
  touchWechatChatSessionLink: mockTouchWechatChatSessionLink,
  upsertWechatChatSessionLink: mockUpsertWechatChatSessionLink,
}));

vi.mock('../../../src/infrastructure/redis.js', () => ({
  getRedis: vi.fn(() => ({
    get: mockGetRedisGet,
    set: mockGetRedisSet,
  })),
}));

vi.mock('../../../src/infrastructure/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  buildWechatSenderHash,
  handleWechatChatCommand,
  runWechatChatSessionTurn,
} from '../../../src/modules/chat/wechat-chat-session-service.js';
import type { Account } from '../../../src/shared/types.js';

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
    mockListChatSessionsForOwnedUser.mockResolvedValue({
      ok: true,
      data: [
        {
          id: 'session-1',
          account_id: 'web:user-1',
          title: '事业复盘',
          created_at: '2026-06-03T07:00:00.000Z',
          updated_at: '2026-06-03T08:00:00.000Z',
          share_token: null,
        },
      ],
    });
    mockGetRedisGet.mockResolvedValue(null);
    mockGetChatSession.mockResolvedValue(createSession());
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

  it('lists recent web sessions and caches resume choices', async () => {
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
});
