import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeRuntimeIpc } from '#runtime/ipc-security';

// Unit tests must not depend on a workspace credential file.
vi.mock('#infrastructure/env', () => ({ readEnvFile: () => ({}) }));

const {
  mockInterruption,
  mockTransaction,
  mockDeliver,
  mockRecover,
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
  mockInterruption: vi.fn(),
  mockTransaction: { query: vi.fn(async () => ({ rows: [{ id: 'user-1' }] })) },
  mockDeliver: vi.fn(),
  mockRecover: vi.fn(async () => null),
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

vi.mock('#infrastructure/repositories/agent-requests-repository', () => ({
  withAgentResultDelivery: mockDeliver,
  withAgentInterruptionDelivery: mockInterruption,
}));

vi.mock('#infrastructure/db', () => ({
  getAllAccounts: vi.fn(),
  getUserById: vi.fn(),
  // 「先落库后结算」的扣费金额回填路径。
  mergeMessageMetadata: vi.fn(async () => undefined),
  storeConversationLog: mockStoreConversationLog,
  storeMessage: mockStoreMessage,
  touchChatSession: mockTouchChatSession,
}));

vi.mock('#infrastructure/daily-usage', () => ({
  incrementDailyMessageCount: mockIncrementDailyMessageCount,
  incrementDailyTokens: mockIncrementDailyTokens,
}));

vi.mock('#infrastructure/redis', () => ({
  getRedis: vi.fn(() => ({
    del: mockDel,
    eval: mockEval,
    publish: mockPublish,
  })),
}));

vi.mock('#infrastructure/logger', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('#modules/billing/plans', () => ({
  settleBillingReservationDetailed: mockSettleBillingReservationDetailed,
  recoverStalePendingReservation: mockRecover,
  settleBillingReservation: mockSettleBillingReservation,
}));

vi.mock('#shared/conversation-log-metrics', () => ({
  recordConversationLogFailure: vi.fn(),
  recordConversationLogSuccess: vi.fn(),
}));

vi.mock('#runtime/local-runner', () => ({
  releaseLocalAgent: mockReleaseLocalAgent,
}));

import type { PendingInboxRequest } from '#runtime/ipc-payloads';
import { getUserById } from '#infrastructure/db';
import { processAiChatOutboxPayload } from '#runtime/ipc-ai-chat-outbox-handler';

describe('processAiChatOutboxPayload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInterruption.mockImplementation(async (_request, _account, callback) =>
      callback(mockTransaction),
    );
    mockDeliver.mockImplementation(async (_request, _account, callback) =>
      callback(mockTransaction),
    );
  });

  it('skips a stale synthetic notice after an actual result wins the row lock', async () => {
    mockInterruption.mockResolvedValueOnce(null);
    await processAiChatOutboxPayload(
      {
        type: 'response',
        requestId: 'late-notice',
        status: 'error',
        text: 'interrupted',
        sessionId: 'session-1',
        metadata: { synthetic_terminal: true },
      },
      'web:user-1',
      new Map(),
    );
    expect(mockStoreMessage).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockEval).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('resolves legacy result ownership inside the delivery transaction without another pool checkout', async () => {
    await processAiChatOutboxPayload(
      {
        type: 'response',
        requestId: 'legacy-owner',
        accountId: 'web:user-1',
        sessionId: 'session-1',
        status: 'success',
        text: 'reply',
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
      },
      'web:user-1',
      new Map(),
    );
    expect(mockTransaction.query).toHaveBeenCalledWith(
      'SELECT id FROM users WHERE id=$1',
      ['user-1'],
    );
    expect(getUserById).not.toHaveBeenCalled();
    expect(mockIncrementDailyTokens).toHaveBeenCalledWith(
      'user-1',
      expect.any(String),
      2,
      3,
      5,
      mockTransaction,
    );
  });

  it('retains pending request and session ownership when delivery rolls back', async () => {
    mockDeliver.mockRejectedValueOnce(new Error('transaction rolled back'));
    const timeout = setTimeout(() => undefined, 10_000);
    const pendingRequests = new Map<string, PendingInboxRequest>([
      [
        'rollback',
        {
          accountId: 'web:user-1',
          ownerUserId: 'user-1',
          sessionId: 'session-1',
          userMessageId: 'u',
          autoDeliver: false,
          resolve: mockResolve,
          reject: mockReject,
          timeout,
        },
      ],
    ]);
    await expect(
      processAiChatOutboxPayload(
        {
          type: 'response',
          requestId: 'rollback',
          status: 'success',
          text: 'done',
        },
        'web:user-1',
        pendingRequests,
      ),
    ).rejects.toThrow('transaction rolled back');
    expect(pendingRequests.has('rollback')).toBe(true);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockEval).not.toHaveBeenCalled();
    expect(mockReleaseLocalAgent).not.toHaveBeenCalled();
    clearTimeout(timeout);
  });

  it('does not consume result or billing receipts for a synthetic timeout', async () => {
    await processAiChatOutboxPayload(
      {
        type: 'response',
        requestId: 'synthetic',
        status: 'error',
        text: 'interrupted',
        sessionId: 'session-1',
        ownerUserId: 'user-1',
        metadata: { synthetic_terminal: true },
      },
      'web:user-1',
      new Map(),
    );
    expect(mockStoreMessage).toHaveBeenCalledTimes(1);
    expect(mockDeliver).not.toHaveBeenCalled();
    expect(mockStoreConversationLog).not.toHaveBeenCalled();
    expect(mockIncrementDailyTokens).not.toHaveBeenCalled();
    expect(mockRecover).not.toHaveBeenCalled();
  });

  it('does not repeat committed usage or messages on result redelivery', async () => {
    const delivered = new Map<string, string | null>();
    mockDeliver.mockImplementation(async (id, _account, callback) => {
      if (delivered.has(id)) return delivered.get(id);
      const result = await callback(mockTransaction);
      delivered.set(id, result);
      return result;
    });
    const payload = {
      type: 'response',
      requestId: 'dedup',
      accountId: 'web:user-1',
      ownerUserId: 'user-1',
      sessionId: 'session-1',
      userMessageId: 'user-1',
      status: 'success',
      text: 'done',
      usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
    };
    await processAiChatOutboxPayload(payload, undefined, new Map());
    await processAiChatOutboxPayload(payload, undefined, new Map());
    expect(mockIncrementDailyTokens).toHaveBeenCalledTimes(1);
    expect(mockIncrementDailyMessageCount).toHaveBeenCalledTimes(1);
    expect(mockStoreMessage).toHaveBeenCalledTimes(1);
    expect(mockStoreConversationLog).toHaveBeenCalledTimes(1);
    expect(mockRecover).toHaveBeenCalledWith({
      requestId: 'dedup',
      promptTokens: 2,
      completionTokens: 1,
    });
  });

  it('keeps committed success when stream publication fails', async () => {
    mockPublish.mockRejectedValueOnce(new Error('Redis unavailable'));
    const timeout = setTimeout(() => undefined, 10_000);
    const pendingRequests = new Map<string, PendingInboxRequest>([
      [
        'notify',
        {
          accountId: 'web:user-1',
          ownerUserId: 'user-1',
          sessionId: 'session-1',
          userMessageId: 'u',
          autoDeliver: false,
          resolve: mockResolve,
          reject: mockReject,
          timeout,
        },
      ],
    ]);
    await expect(
      processAiChatOutboxPayload(
        {
          type: 'response',
          requestId: 'notify',
          status: 'success',
          text: 'done',
        },
        'web:user-1',
        pendingRequests,
      ),
    ).resolves.toBeUndefined();
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' }),
    );
    expect(mockStoreMessage).toHaveBeenCalledTimes(1);
  });

  it('fails delivery before billing when the required usage log cannot be stored', async () => {
    mockStoreConversationLog.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    await expect(
      processAiChatOutboxPayload(
        {
          type: 'response',
          requestId: 'failed-log',
          status: 'success',
          text: 'done',
          sessionId: 'session-1',
          ownerUserId: 'user-1',
          usage: { totalTokens: 5 },
        },
        'web:user-1',
        new Map(),
      ),
    ).rejects.toThrow('database unavailable');
    expect(mockStoreMessage).not.toHaveBeenCalled();
    expect(mockRecover).not.toHaveBeenCalled();
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
          localAgentLeaseId: 'web:user-1',
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
      mockTransaction,
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
      mockTransaction,
    );
    expect(mockTouchChatSession).toHaveBeenCalledWith(
      'session-1',
      mockTransaction,
    );
    expect(mockIncrementDailyMessageCount).toHaveBeenCalledWith(
      'user-1',
      expect.any(String),
      mockTransaction,
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
      mockTransaction,
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
      mockTransaction,
    );
    const stream = decodeRuntimeIpc(
      'web:user-1',
      mockPublish.mock.calls[0][0],
      mockPublish.mock.calls[0][1],
    );
    expect(stream).toContain('"promptTokens":15');
    expect(stream).toContain('"actual_charge_coins":1.23');
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
      mockTransaction,
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
      mockTransaction,
    );
    expect(mockTouchChatSession).toHaveBeenCalledWith(
      'session-payload',
      mockTransaction,
    );
    expect(mockIncrementDailyMessageCount).toHaveBeenCalledWith(
      'user-payload',
      expect.any(String),
      mockTransaction,
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
      mockTransaction,
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
