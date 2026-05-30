import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockDel,
  mockIncrementDailyTokens,
  mockPublish,
  mockResolve,
  mockReject,
  mockSettleBillingReservation,
  mockStoreConversationLog,
} = vi.hoisted(() => ({
  mockDel: vi.fn(async () => 1),
  mockIncrementDailyTokens: vi.fn(),
  mockPublish: vi.fn(async () => 1),
  mockResolve: vi.fn(),
  mockReject: vi.fn(),
  mockSettleBillingReservation: vi.fn(async () => 0),
  mockStoreConversationLog: vi.fn(async () => undefined),
}));

vi.mock('../infrastructure/db.js', () => ({
  getAllAccounts: vi.fn(),
  getUserById: vi.fn(),
  storeConversationLog: mockStoreConversationLog,
  storeMessage: vi.fn(),
}));

vi.mock('../infrastructure/daily-usage.js', () => ({
  incrementDailyTokens: mockIncrementDailyTokens,
}));

vi.mock('../infrastructure/redis.js', () => ({
  getRedis: vi.fn(() => ({
    del: mockDel,
    publish: mockPublish,
  })),
}));

vi.mock('../infrastructure/logger.js', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../modules/billing/plans.js', () => ({
  settleBillingReservation: mockSettleBillingReservation,
}));

vi.mock('../shared/conversation-log-metrics.js', () => ({
  recordConversationLogFailure: vi.fn(),
  recordConversationLogSuccess: vi.fn(),
}));

import type { PendingInboxRequest } from './ipc-payloads.js';
import { processAiChatOutboxPayload } from './ipc-ai-chat-outbox-handler.js';

describe('processAiChatOutboxPayload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves AI Chat responses with every assistant transcript message', async () => {
    const timeout = setTimeout(() => undefined, 10_000);
    const pendingRequests = new Map<string, PendingInboxRequest>([
      [
        'req-1',
        {
          accountId: 'web:user-1',
          ownerUserId: 'user-1',
          autoDeliver: false,
          sessionId: 'session-1',
          resolve: mockResolve,
          reject: mockReject,
          timeout,
        },
      ],
    ]);

    await processAiChatOutboxPayload(
      {
        type: 'response',
        accountId: 'web:user-1',
        requestId: 'req-1',
        text: 'second reply',
        status: 'success',
        usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
        transcript: [
          { type: 'assistant', text: 'first reply' },
          { type: 'assistant', text: 'second reply' },
        ],
      },
      'web:user-1',
      pendingRequests,
    );

    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-1',
        status: 'success',
        text: 'second reply\n\n📥 3 · 📤 5 Finished',
        assistantMessages: [
          'first reply',
          'second reply\n\n📥 3 · 📤 5 Finished',
        ],
      }),
    );
    expect(pendingRequests.has('req-1')).toBe(false);
    expect(mockDel).toHaveBeenCalledWith('session:processing:session-1');
  });

  it('uses normalized total token usage for markers, stats, billing, stream, and logs', async () => {
    const timeout = setTimeout(() => undefined, 10_000);
    const pendingRequests = new Map<string, PendingInboxRequest>([
      [
        'req-2',
        {
          accountId: 'web:user-1',
          ownerUserId: 'user-1',
          autoDeliver: false,
          sessionId: 'session-2',
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
          resolve: mockResolve,
          reject: mockReject,
          timeout,
        },
      ],
    ]);

    await processAiChatOutboxPayload(
      {
        type: 'response',
        accountId: 'web:user-1',
        requestId: 'req-2',
        text: 'reply',
        status: 'success',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 20 },
        transcript: [{ type: 'assistant', text: 'reply' }],
      },
      'web:user-1',
      pendingRequests,
    );

    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'reply\n\n📥 15 · 📤 5 Finished',
      }),
    );
    expect(mockIncrementDailyTokens).toHaveBeenCalledWith(
      'user-1',
      expect.any(String),
      15,
      5,
    );
    expect(mockSettleBillingReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-2',
        promptTokens: 15,
        completionTokens: 5,
      }),
    );
    expect(mockStoreConversationLog).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: { promptTokens: 15, completionTokens: 5, totalTokens: 20 },
      }),
    );
    expect(mockPublish).toHaveBeenCalledWith(
      'ipc:ai-chat:stream:session-2',
      expect.stringContaining('"promptTokens":15'),
    );
  });

  it('records total-only usage as input tokens', async () => {
    const timeout = setTimeout(() => undefined, 10_000);
    const pendingRequests = new Map<string, PendingInboxRequest>([
      [
        'req-3',
        {
          accountId: 'web:user-1',
          ownerUserId: 'user-1',
          autoDeliver: false,
          sessionId: 'session-3',
          resolve: mockResolve,
          reject: mockReject,
          timeout,
        },
      ],
    ]);

    await processAiChatOutboxPayload(
      {
        type: 'response',
        accountId: 'web:user-1',
        requestId: 'req-3',
        text: 'reply',
        status: 'success',
        usage: { totalTokens: 20 },
      },
      'web:user-1',
      pendingRequests,
    );

    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'reply\n\n📥 20 · 📤 0 Finished',
      }),
    );
    expect(mockIncrementDailyTokens).toHaveBeenCalledWith(
      'user-1',
      expect.any(String),
      20,
      0,
    );
  });
});
