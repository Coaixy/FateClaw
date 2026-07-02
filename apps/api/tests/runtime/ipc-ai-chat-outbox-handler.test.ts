import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockDel,
  mockEval,
  mockIncrementDailyTokens,
  mockPublish,
  mockReleaseLocalAgent,
  mockResolve,
  mockReject,
  mockSettleBillingReservationDetailed,
  mockSettleBillingReservation,
  mockStoreConversationLog,
  mockStoreMessage,
  mockTouchChatSession,
  mockIncrementDailyMessageCount,
} = vi.hoisted(() => ({
  mockDel: vi.fn(async () => 1),
  mockEval: vi.fn(async () => 1),
  mockIncrementDailyTokens: vi.fn(),
  mockPublish: vi.fn(async () => 1),
  mockReleaseLocalAgent: vi.fn(async () => undefined),
  mockResolve: vi.fn(),
  mockReject: vi.fn(),
  mockSettleBillingReservationDetailed: vi.fn(async () => ({
    actualChargeCoins: 1.23,
    rawChargeCoins: 1.23,
  })),
  mockSettleBillingReservation: vi.fn(async () => 1.23),
  mockStoreConversationLog: vi.fn(async () => undefined),
  mockStoreMessage: vi.fn(async () => undefined),
  mockTouchChatSession: vi.fn(async () => undefined),
  mockIncrementDailyMessageCount: vi.fn(async () => undefined),
}));

vi.mock('../../src/infrastructure/db.js', () => ({
  getAllAccounts: vi.fn(),
  getUserById: vi.fn(),
  // 「先落库后结算」的扣费金额回填路径。
  mergeMessageMetadata: vi.fn(async () => undefined),
  storeConversationLog: mockStoreConversationLog,
  storeMessage: mockStoreMessage,
  touchChatSession: mockTouchChatSession,
}));

vi.mock('../../src/infrastructure/daily-usage.js', () => ({
  incrementDailyMessageCount: mockIncrementDailyMessageCount,
  incrementDailyTokens: mockIncrementDailyTokens,
}));

vi.mock('../../src/infrastructure/redis.js', () => ({
  getRedis: vi.fn(() => ({
    del: mockDel,
    eval: mockEval,
    publish: mockPublish,
  })),
}));

vi.mock('../../src/infrastructure/logger.js', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../src/modules/billing/plans.js', () => ({
  settleBillingReservationDetailed: mockSettleBillingReservationDetailed,
  settleBillingReservation: mockSettleBillingReservation,
}));

vi.mock('../../src/shared/conversation-log-metrics.js', () => ({
  recordConversationLogFailure: vi.fn(),
  recordConversationLogSuccess: vi.fn(),
}));

vi.mock('../../src/runtime/local-runner.js', () => ({
  releaseLocalAgent: mockReleaseLocalAgent,
}));

import type { PendingInboxRequest } from '../../src/runtime/ipc-payloads.js';
import { processAiChatOutboxPayload } from '../../src/runtime/ipc-ai-chat-outbox-handler.js';

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
          userMessageId: 'user-msg-1',
          startedAtMs: Date.now() - 1234,
          localAgentLeaseAccountId: 'web:user-1',
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
        metadata: expect.objectContaining({
          kind: 'final',
          duration_ms: expect.any(Number),
          request_id: 'req-1',
        }),
      }),
    );
    expect(mockStoreMessage).toHaveBeenCalledTimes(2);
    expect(mockStoreMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: 'user-msg-1_reply_1',
        account_id: 'web:user-1',
        user_id: 'user-1',
        session_id: 'session-1',
        content: 'first reply',
        metadata: {
          kind: 'assistant',
          request_id: 'req-1',
        },
        tool_context: null,
      }),
    );
    expect(mockStoreMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: 'user-msg-1_reply_2',
        content: 'second reply\n\n📥 3 · 📤 5 Finished',
        metadata: expect.objectContaining({
          kind: 'final',
          turn_complete: true,
          request_id: 'req-1',
        }),
      }),
    );
    expect(mockTouchChatSession).toHaveBeenCalledWith('session-1');
    expect(mockIncrementDailyMessageCount).toHaveBeenCalledWith(
      'user-1',
      expect.any(String),
    );
    expect(pendingRequests.has('req-1')).toBe(false);
    expect(mockEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('DEL', KEYS[1])"),
      1,
      'session:processing:session-1',
      'req-1',
    );
    expect(mockDel).not.toHaveBeenCalled();
    expect(mockReleaseLocalAgent).toHaveBeenCalledWith('web:user-1');
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
        metadata: expect.objectContaining({
          actual_charge_coins: 1.23,
          raw_charge_coins: 1.23,
        }),
      }),
    );
    expect(mockIncrementDailyTokens).toHaveBeenCalledWith(
      'user-1',
      expect.any(String),
      15,
      5,
      20,
    );
    expect(mockSettleBillingReservationDetailed).toHaveBeenCalledWith(
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
    expect(mockPublish).toHaveBeenCalledWith(
      'ipc:ai-chat:stream:session-2',
      expect.stringContaining('"actual_charge_coins":1.23'),
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
      20,
    );
  });

  it('stores final responses using payload context when local pending is absent', async () => {
    const pendingRequests = new Map<string, PendingInboxRequest>();

    await processAiChatOutboxPayload(
      {
        type: 'response',
        accountId: 'web:user-payload',
        requestId: 'req-payload',
        sessionId: 'session-payload',
        userMessageId: 'user-msg-payload',
        ownerUserId: 'user-payload',
        text: 'payload reply',
        status: 'success',
      },
      'web:user-payload',
      pendingRequests,
    );

    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockStoreMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'user-msg-payload_reply',
        account_id: 'web:user-payload',
        user_id: 'user-payload',
        session_id: 'session-payload',
        content: 'payload reply\n\n📥 0 · 📤 0 Finished',
        metadata: expect.objectContaining({
          kind: 'final',
          turn_complete: true,
          request_id: 'req-payload',
        }),
      }),
    );
    expect(mockTouchChatSession).toHaveBeenCalledWith('session-payload');
    expect(mockIncrementDailyMessageCount).toHaveBeenCalledWith(
      'user-payload',
      expect.any(String),
    );
    expect(mockEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('DEL', KEYS[1])"),
      1,
      'session:processing:session-payload',
      'req-payload',
    );
  });

  it('stores error responses as final error messages without counting successful sends', async () => {
    const timeout = setTimeout(() => undefined, 10_000);
    const pendingRequests = new Map<string, PendingInboxRequest>([
      [
        'req-error',
        {
          accountId: 'web:user-1',
          ownerUserId: 'user-1',
          autoDeliver: false,
          sessionId: 'session-error',
          userMessageId: 'user-msg-error',
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
        requestId: 'req-error',
        text: '内部错误详情',
        status: 'error',
        error: 'raw error',
        publicErrorText: '这次没有完成',
        publicReasonCode: 'internal_error',
      },
      'web:user-1',
      pendingRequests,
    );

    expect(mockStoreMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'user-msg-error_error',
        content: '这次没有完成',
        metadata: expect.objectContaining({
          kind: 'error',
          turn_complete: true,
          request_id: 'req-error',
        }),
      }),
    );
    expect(mockIncrementDailyMessageCount).not.toHaveBeenCalled();
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        publicErrorText: '这次没有完成',
      }),
    );
  });
});
