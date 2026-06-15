import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockHandleWechatChatCommand,
  mockGetMembershipOverview,
  mockGetRecentMessages,
  mockGetSoulContent,
  mockGetUserByAccountId,
  mockIncrementDailyMessageCount,
  mockParseWeixinMessage,
  mockRunWechatChatSessionTurn,
  mockSendMessage,
  mockStoreMessage,
} = vi.hoisted(() => ({
  mockHandleWechatChatCommand: vi.fn(),
  mockGetMembershipOverview: vi.fn(),
  mockGetRecentMessages: vi.fn(),
  mockGetSoulContent: vi.fn(),
  mockGetUserByAccountId: vi.fn(),
  mockIncrementDailyMessageCount: vi.fn(),
  mockParseWeixinMessage: vi.fn(),
  mockRunWechatChatSessionTurn: vi.fn(),
  mockSendMessage: vi.fn(),
  mockStoreMessage: vi.fn(),
}));

vi.mock('../../../src/infrastructure/db.js', () => ({
  getMembershipOverview: mockGetMembershipOverview,
  getRecentMessages: mockGetRecentMessages,
  getSoulContent: mockGetSoulContent,
  getUserByAccountId: mockGetUserByAccountId,
  storeMessage: mockStoreMessage,
}));

vi.mock('../../../src/infrastructure/daily-usage.js', () => ({
  incrementDailyMessageCount: mockIncrementDailyMessageCount,
}));

vi.mock('../../../src/infrastructure/ilink.js', () => ({
  parseWeixinMessage: mockParseWeixinMessage,
  sendMessage: mockSendMessage,
}));

vi.mock('../../../src/infrastructure/logger.js', () => ({
  logger: {
    child: vi.fn(() => ({
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    })),
    debug: vi.fn(),
  },
}));

vi.mock('../../../src/runtime/resident-agent.js', () => ({
  dispatchResidentPrompt: vi.fn(),
}));

vi.mock('../../../src/modules/system/system-config.js', () => ({
  resolveUserLlmRuntime: vi.fn(),
}));

vi.mock('../../../src/modules/chat/wechat-chat-session-service.js', () => ({
  handleWechatChatCommand: mockHandleWechatChatCommand,
  runWechatChatSessionTurn: mockRunWechatChatSessionTurn,
  WECHAT_CHAT_THINKING_ACK:
    '收到，正在思考。完成后会直接回复；期间新消息不会进入本轮。',
}));

import {
  buildWeixinRuntimeSessionId,
  processWeixinMessage,
} from '../../../src/modules/chat/message-handler.js';
import type { Account } from '../../../src/shared/types.js';
import type { WeixinMessage } from '../../../src/infrastructure/ilink.js';

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

describe('buildWeixinRuntimeSessionId', () => {
  it('builds a stable de-identified Pi session id', () => {
    const accountId = 'bot-1@im.bot';
    const sender = 'sender-1@im.weixin';

    const first = buildWeixinRuntimeSessionId(accountId, sender);
    const second = buildWeixinRuntimeSessionId(accountId, sender);

    expect(first).toBe(second);
    expect(first).toMatch(/^wx-[a-f0-9]{32}$/);
    expect(first).not.toContain(accountId);
    expect(first).not.toContain(sender);
  });
});

describe('processWeixinMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserByAccountId.mockResolvedValue({ id: 'user-1' });
    mockGetMembershipOverview.mockResolvedValue({
      active: true,
      membership: { plan_key: 'fateclaw_deep' },
    });
    mockHandleWechatChatCommand.mockResolvedValue({ handled: false });
    mockRunWechatChatSessionTurn.mockImplementation(async (input) => {
      await input.onAccepted?.();
      return {
        status: 'completed',
        sessionId: 'session-1',
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
      };
    });
    mockStoreMessage.mockResolvedValue(undefined);
    mockSendMessage.mockResolvedValue('client-1');
    mockIncrementDailyMessageCount.mockResolvedValue(undefined);
    mockGetRecentMessages.mockResolvedValue([]);
    mockGetSoulContent.mockResolvedValue('');
  });

  it('routes text chat into a web chat session and delivers only ack plus final messages', async () => {
    const account = createAccount();
    const sender = 'sender-1@im.weixin';
    const msg: WeixinMessage = {
      message_id: 123,
      from_user_id: sender,
      create_time_ms: Date.parse('2026-06-03T08:00:00.000Z'),
      context_token: 'ctx-1',
    };
    mockParseWeixinMessage.mockReturnValue({
      content: '你好',
      sender,
      sender_name: '用户甲',
    });

    await processWeixinMessage(account, msg);

    expect(mockStoreMessage).not.toHaveBeenCalled();
    expect(mockGetRecentMessages).not.toHaveBeenCalled();
    expect(mockHandleWechatChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        owner: { id: 'user-1' },
        sender,
        content: '你好',
      }),
    );
    expect(mockRunWechatChatSessionTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        owner: { id: 'user-1' },
        sender,
        messageId: '123',
        content: '你好',
      }),
    );
    expect(mockSendMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: account.id }),
      sender,
      '收到，正在思考。完成后会直接回复；期间新消息不会进入本轮。',
      'ctx-1',
    );
    expect(mockSendMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: account.id }),
      sender,
      '最终回复',
      'ctx-1',
    );
  });

  it('handles slash commands without entering the chat session turn', async () => {
    const account = createAccount();
    const sender = 'sender-1@im.weixin';
    mockParseWeixinMessage.mockReturnValue({
      content: '/sessions',
      sender,
      sender_name: '用户甲',
    });
    mockHandleWechatChatCommand.mockResolvedValue({
      handled: true,
      replyText: '选择要接续的网页会话',
    });

    await processWeixinMessage(account, {
      message_id: 124,
      from_user_id: sender,
      context_token: 'ctx-2',
    });

    expect(mockRunWechatChatSessionTurn).not.toHaveBeenCalled();
    expect(mockStoreMessage).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: account.id }),
      sender,
      '选择要接续的网页会话',
      'ctx-2',
    );
  });

  it('drops busy wechat messages without ack or final delivery', async () => {
    const account = createAccount();
    const sender = 'sender-1@im.weixin';
    mockParseWeixinMessage.mockReturnValue({
      content: '第二条',
      sender,
      sender_name: '用户甲',
    });
    mockRunWechatChatSessionTurn.mockResolvedValue({
      status: 'discarded',
      sessionId: 'session-1',
    });

    await processWeixinMessage(account, {
      message_id: 125,
      from_user_id: sender,
      context_token: 'ctx-3',
    });

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockStoreMessage).not.toHaveBeenCalled();
    expect(mockIncrementDailyMessageCount).not.toHaveBeenCalled();
  });

  it('keeps non-member wechat gate before commands and session routing', async () => {
    const account = createAccount();
    const sender = 'sender-1@im.weixin';
    mockGetMembershipOverview.mockResolvedValue({ active: false });
    mockParseWeixinMessage.mockReturnValue({
      content: '/sessions',
      sender,
      sender_name: '用户甲',
    });

    await processWeixinMessage(account, {
      message_id: 126,
      from_user_id: sender,
      context_token: 'ctx-4',
    });

    expect(mockHandleWechatChatCommand).not.toHaveBeenCalled();
    expect(mockRunWechatChatSessionTurn).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: account.id }),
      sender,
      expect.stringContaining('Deep'),
      'ctx-4',
    );
  });
});
