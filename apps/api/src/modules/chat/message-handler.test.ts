import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockDispatchResidentPrompt,
  mockGetMembershipOverview,
  mockGetRecentMessages,
  mockGetSoulContent,
  mockGetUserByAccountId,
  mockIncrementDailyMessageCount,
  mockParseWeixinMessage,
  mockResolveUserLlmRuntime,
  mockSendMessage,
  mockStoreMessage,
} = vi.hoisted(() => ({
  mockDispatchResidentPrompt: vi.fn(),
  mockGetMembershipOverview: vi.fn(),
  mockGetRecentMessages: vi.fn(),
  mockGetSoulContent: vi.fn(),
  mockGetUserByAccountId: vi.fn(),
  mockIncrementDailyMessageCount: vi.fn(),
  mockParseWeixinMessage: vi.fn(),
  mockResolveUserLlmRuntime: vi.fn(),
  mockSendMessage: vi.fn(),
  mockStoreMessage: vi.fn(),
}));

vi.mock('../../infrastructure/db.js', () => ({
  getMembershipOverview: mockGetMembershipOverview,
  getRecentMessages: mockGetRecentMessages,
  getSoulContent: mockGetSoulContent,
  getUserByAccountId: mockGetUserByAccountId,
  storeMessage: mockStoreMessage,
}));

vi.mock('../../infrastructure/daily-usage.js', () => ({
  incrementDailyMessageCount: mockIncrementDailyMessageCount,
}));

vi.mock('../../infrastructure/ilink.js', () => ({
  parseWeixinMessage: mockParseWeixinMessage,
  sendMessage: mockSendMessage,
}));

vi.mock('../../infrastructure/logger.js', () => ({
  logger: {
    child: vi.fn(() => ({
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    })),
    debug: vi.fn(),
  },
}));

vi.mock('../../runtime/resident-agent.js', () => ({
  dispatchResidentPrompt: mockDispatchResidentPrompt,
}));

vi.mock('../system/system-config.js', () => ({
  resolveUserLlmRuntime: mockResolveUserLlmRuntime,
}));

import {
  buildWeixinRuntimeSessionId,
  processWeixinMessage,
} from './message-handler.js';
import type { Account } from '../../shared/types.js';
import type { WeixinMessage } from '../../infrastructure/ilink.js';

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

function createRuntime() {
  return {
    source: 'custom',
    billingMode: 'none',
    modelConfigId: 'model-1',
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
    mockGetMembershipOverview.mockResolvedValue({ active: true });
    mockResolveUserLlmRuntime.mockResolvedValue(createRuntime());
    mockDispatchResidentPrompt.mockResolvedValue({
      requestId: 'inbox-1',
      status: 'success',
      text: '你好',
    });
    mockStoreMessage.mockResolvedValue(undefined);
    mockIncrementDailyMessageCount.mockResolvedValue(undefined);
    mockGetRecentMessages.mockResolvedValue([]);
    mockGetSoulContent.mockResolvedValue('');
  });

  it('dispatches text chat with a stable Pi session id and no account-wide history', async () => {
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

    expect(mockStoreMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '123',
        account_id: account.id,
        sender,
        content: '你好',
        is_bot_message: false,
      }),
    );
    expect(mockGetRecentMessages).not.toHaveBeenCalled();
    expect(mockDispatchResidentPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: account.id,
        type: 'chat',
        userMessage: '你好',
        history: [],
        toUserId: sender,
        contextToken: 'ctx-1',
        autoDeliver: true,
        sessionId: buildWeixinRuntimeSessionId(account.id, sender),
      }),
    );
    expect(mockIncrementDailyMessageCount).toHaveBeenCalledWith(
      'user-1',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
  });
});
