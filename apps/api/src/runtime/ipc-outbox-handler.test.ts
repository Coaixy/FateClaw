import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetAccount,
  mockGetUserByAccountId,
  mockIncrementDailyTokens,
  mockSendMessage,
  mockSettleBillingReservation,
  mockStoreConversationLog,
  mockStoreMessage,
} = vi.hoisted(() => ({
  mockGetAccount: vi.fn(),
  mockGetUserByAccountId: vi.fn(),
  mockIncrementDailyTokens: vi.fn(),
  mockSendMessage: vi.fn(async () => 'client-msg-1'),
  mockSettleBillingReservation: vi.fn(async () => 0),
  mockStoreConversationLog: vi.fn(async () => undefined),
  mockStoreMessage: vi.fn(async () => undefined),
}));

vi.mock('../infrastructure/db.js', () => ({
  getAllAccounts: vi.fn(),
  getAccount: mockGetAccount,
  getUserByAccountId: mockGetUserByAccountId,
  storeConversationLog: mockStoreConversationLog,
  storeMessage: mockStoreMessage,
}));

vi.mock('../infrastructure/daily-usage.js', () => ({
  incrementDailyTokens: mockIncrementDailyTokens,
}));

vi.mock('../infrastructure/ilink.js', () => ({
  sendMessage: mockSendMessage,
}));

vi.mock('../infrastructure/redis.js', () => ({
  getRedis: vi.fn(() => ({
    del: vi.fn(async () => 1),
  })),
}));

vi.mock('../infrastructure/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../modules/billing/plans.js', () => ({
  releaseBillingReservation: vi.fn(),
  settleBillingReservation: mockSettleBillingReservation,
}));

vi.mock('../shared/conversation-log-metrics.js', () => ({
  recordConversationLogFailure: vi.fn(),
  recordConversationLogSuccess: vi.fn(),
}));

import type { PendingInboxRequest } from './ipc-payloads.js';
import { processOutboxPayload } from './ipc-outbox-handler.js';

describe('processOutboxPayload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccount.mockResolvedValue({
      id: 'account-1',
      user_id: 'wechat-user-1',
      name: '测试账号',
      bot_token: 'bot-token',
      base_url: 'https://example.com',
    });
    mockGetUserByAccountId.mockResolvedValue({ id: 'user-1' });
  });

  it('uses normalized total token usage for delivery marker, stats, billing, and logs', async () => {
    const timeout = setTimeout(() => undefined, 10_000);
    const resolve = vi.fn();
    const pendingRequests = new Map<string, PendingInboxRequest>([
      [
        'req-1',
        {
          accountId: 'account-1',
          autoDeliver: true,
          llmRuntime: {
            source: 'official',
            billingMode: 'metered',
            modelConfigId: 'official-1',
            piApi: 'openai-completions',
            model: 'gpt-4.1',
            apiKey: 'secret',
            authMode: 'openai_api_key',
            providerKey: 'openai-main',
            inputTokenPricePerMillionCoins: 1000,
            outputTokenPricePerMillionCoins: 5000,
          },
          resolve,
          reject: vi.fn(),
          timeout,
        },
      ],
    ]);

    await processOutboxPayload(
      {
        type: 'response',
        accountId: 'account-1',
        requestId: 'req-1',
        text: 'reply',
        status: 'success',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 20 },
        transcript: [{ type: 'assistant', text: 'reply' }],
      },
      'account-1',
      pendingRequests,
    );

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'account-1' }),
      'wechat-user-1',
      'reply\n\n📥 15 · 📤 5 Finished',
      undefined,
    );
    expect(mockIncrementDailyTokens).toHaveBeenCalledWith(
      'user-1',
      expect.any(String),
      15,
      5,
    );
    expect(mockSettleBillingReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-1',
        promptTokens: 15,
        completionTokens: 5,
      }),
    );
    expect(mockStoreConversationLog).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: { promptTokens: 15, completionTokens: 5, totalTokens: 20 },
      }),
    );
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'reply\n\n📥 15 · 📤 5 Finished',
      }),
    );
  });
});
