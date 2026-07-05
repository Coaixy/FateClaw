import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockHandleWechatChatCommand,
  mockGetRuntimeEntitlementSnapshot,
  mockGetRecentMessages,
  mockGetSoulContent,
  mockGetUserByAccountId,
  mockGetUserById,
  mockIncrementDailyMessageCount,
  mockParseWeixinMessage,
  mockRunWechatChatSessionTurn,
  mockSendMessage,
  mockStoreMessage,
} = vi.hoisted(() => ({
  mockHandleWechatChatCommand: vi.fn(),
  mockGetRuntimeEntitlementSnapshot: vi.fn(),
  mockGetRecentMessages: vi.fn(),
  mockGetSoulContent: vi.fn(),
  mockGetUserByAccountId: vi.fn(),
  mockGetUserById: vi.fn(),
  mockIncrementDailyMessageCount: vi.fn(),
  mockParseWeixinMessage: vi.fn(),
  mockRunWechatChatSessionTurn: vi.fn(),
  mockSendMessage: vi.fn(),
  mockStoreMessage: vi.fn(),
}));

vi.mock('../../../src/infrastructure/db.js', () => ({
  expireUserBonusBalanceBefore: vi.fn(async () => ({
    expired: 0,
    totalCoinsExpired: 0,
  })),
  getRecentMessages: mockGetRecentMessages,
  getSoulContent: mockGetSoulContent,
  getUserByAccountId: mockGetUserByAccountId,
  getUserById: mockGetUserById,
  storeMessage: mockStoreMessage,
}));

vi.mock('../../../src/modules/billing/entitlements.js', () => ({
  getRuntimeEntitlementSnapshot: mockGetRuntimeEntitlementSnapshot,
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

vi.mock('../../../src/modules/system/system-config.js', () => ({
  resolveUserLlmRuntime: vi.fn(),
}));

vi.mock('../../../src/modules/chat/wechat-chat-session-service.js', () => ({
  handleWechatChatCommand: mockHandleWechatChatCommand,
  runWechatChatSessionTurn: mockRunWechatChatSessionTurn,
  WECHAT_CHAT_THINKING_ACK:
    '收到，正在思考。完成后会直接回复；期间新消息不会进入本轮。',
}));

import { processWeixinMessage } from '../../../src/modules/chat/message-handler.js';
import { FREE_WECHAT_UNSUPPORTED_MESSAGE } from '../../../src/modules/account/account-service.js';
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

describe('processWeixinMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserByAccountId.mockResolvedValue({ id: 'user-1' });
    mockGetUserById.mockResolvedValue({
      id: 'user-1',
      purchased_coins: 0,
      bonus_coins: 0,
      reserved_coins: 0,
    });
    // 微信 Claw 已可逆停用：canUseWechatClaw 恒为 false（WECHAT_CLAW_FEATURE_ENABLED=false）。
    mockGetRuntimeEntitlementSnapshot.mockResolvedValue({
      canUseWechatClaw: false,
    });
    mockHandleWechatChatCommand.mockResolvedValue({ handled: false });
    mockRunWechatChatSessionTurn.mockResolvedValue({
      status: 'completed',
      sessionId: 'session-1',
      finalAssistantMessages: [],
    });
    mockStoreMessage.mockResolvedValue(undefined);
    mockSendMessage.mockResolvedValue('client-1');
    mockIncrementDailyMessageCount.mockResolvedValue(undefined);
    mockGetRecentMessages.mockResolvedValue([]);
    mockGetSoulContent.mockResolvedValue('');
  });

  it('blocks active members with the disabled-feature reply before any routing', async () => {
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

    // 微信功能停用后：无论是否会员，命令路由与会话轮次都不再触发。
    expect(mockHandleWechatChatCommand).not.toHaveBeenCalled();
    expect(mockRunWechatChatSessionTurn).not.toHaveBeenCalled();
    expect(mockStoreMessage).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: account.id }),
      sender,
      FREE_WECHAT_UNSUPPORTED_MESSAGE,
      'ctx-1',
    );
  });

  it('blocks slash commands with the disabled-feature reply', async () => {
    const account = createAccount();
    const sender = 'sender-1@im.weixin';
    mockParseWeixinMessage.mockReturnValue({
      content: '/sessions',
      sender,
      sender_name: '用户甲',
    });

    await processWeixinMessage(account, {
      message_id: 124,
      from_user_id: sender,
      context_token: 'ctx-2',
    });

    expect(mockHandleWechatChatCommand).not.toHaveBeenCalled();
    expect(mockRunWechatChatSessionTurn).not.toHaveBeenCalled();
    expect(mockStoreMessage).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: account.id }),
      sender,
      FREE_WECHAT_UNSUPPORTED_MESSAGE,
      'ctx-2',
    );
  });

  it('blocks inactive members with the same disabled-feature reply', async () => {
    const account = createAccount();
    const sender = 'sender-1@im.weixin';
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
      FREE_WECHAT_UNSUPPORTED_MESSAGE,
      'ctx-4',
    );
  });
});
