import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGet,
  mockDel,
  mockEval,
  mockLindex,
  mockLlen,
  mockLpush,
  mockLrem,
  mockLoggerInfo,
  mockReleaseLocalAgent,
  mockRetainLocalAgent,
  mockRpop,
  mockRpush,
  mockSettleBillingReservation,
  mockZrem,
} = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockDel: vi.fn(async () => 1),
  mockEval: vi.fn(async () => 1),
  mockLindex: vi.fn(),
  mockLlen: vi.fn(async () => 0),
  mockLpush: vi.fn(async () => 1),
  mockLrem: vi.fn(async () => 1),
  mockLoggerInfo: vi.fn(),
  mockReleaseLocalAgent: vi.fn(async () => undefined),
  mockRetainLocalAgent: vi.fn((accountId: string) => accountId),
  mockRpop: vi.fn(),
  mockRpush: vi.fn(async () => 1),
  mockSettleBillingReservation: vi.fn(async () => 0),
  mockZrem: vi.fn(async () => 1),
}));

vi.mock('../infrastructure/db.js', () => ({
  getMembershipOverview: vi.fn(async () => ({ active: false })),
  getUserByAccountId: vi.fn(),
  getUserById: vi.fn(),
}));

vi.mock('../infrastructure/redis.js', () => ({
  getRedis: vi.fn(() => ({
    get: mockGet,
    del: mockDel,
    eval: mockEval,
    lindex: mockLindex,
    llen: mockLlen,
    lpush: mockLpush,
    lrem: mockLrem,
    rpop: mockRpop,
    rpush: mockRpush,
    zrem: mockZrem,
  })),
}));

vi.mock('../infrastructure/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: mockLoggerInfo,
    warn: vi.fn(),
  },
}));

vi.mock('./ipc-outbox-handler.js', () => ({
  processOutboxPayload: vi.fn(),
}));

vi.mock('./ipc-ai-chat-outbox-handler.js', () => ({
  processAiChatOutboxPayload: vi.fn(),
}));

vi.mock('./local-runner.js', () => ({
  releaseLocalAgent: mockReleaseLocalAgent,
  retainLocalAgent: mockRetainLocalAgent,
}));

vi.mock('../modules/billing/plans.js', () => ({
  reserveBillingForRequest: vi.fn(),
  settleBillingReservation: mockSettleBillingReservation,
}));

vi.mock('../modules/account/account-service.js', () => ({
  FREE_WECHAT_UNSUPPORTED_MESSAGE: 'free unsupported',
}));

vi.mock('../modules/chat/web-chat-runtime.js', () => ({
  getUserIdFromWebChatRuntimeId: vi.fn(),
}));

vi.mock('../modules/system/system-config.js', () => ({
  getAgentConcurrencyLimit: vi.fn(async () => 10),
  resolveUserLlmRuntime: vi.fn(),
}));

import {
  _resetIpcWorkerForTests,
  __getPendingAiChatRequestsForTests,
  cancelAiChatSessionRequest,
  submitAiChatInboxRequest,
  submitInboxRequest,
} from './ipc-worker.js';
import type { PendingInboxRequest } from './ipc-payloads.js';
import {
  getMembershipOverview,
  getUserByAccountId,
} from '../infrastructure/db.js';

const effectiveRuntime = {
  source: 'official' as const,
  billingMode: 'metered' as const,
  modelConfigId: 'official-1',
  providerKey: 'openai-main',
  piApi: 'openai-completions' as const,
  displayName: 'OpenAI Main',
  authMode: 'openai_api_key' as const,
  secret: 'secret',
  secretSource: 'database' as const,
  baseUrl: null,
  model: 'gpt-4.1',
  contextWindowTokens: 128_000,
  maxOutputTokens: 10_240,
  thinkingLevel: 'medium' as const,
  inputTokenPricePerMillionCoins: 1000,
  outputTokenPricePerMillionCoins: 5000,
};

function createPending(
  overrides: Partial<PendingInboxRequest> = {},
): PendingInboxRequest {
  return {
    accountId: 'web:user-1',
    ownerUserId: 'user-1',
    autoDeliver: false,
    sessionId: 'session-1',
    localAgentLeaseAccountId: 'web:user-1',
    resolve: vi.fn(),
    reject: vi.fn(),
    timeout: setTimeout(() => undefined, 10_000),
    ...overrides,
  };
}

describe('cancelAiChatSessionRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('releases the busy marker and enqueues a cancel request for the active AI chat', async () => {
    const pendingRequests = (
      await import('./ipc-worker.js')
    ).__getPendingAiChatRequestsForTests();
    pendingRequests.clear();
    const pending = createPending();
    pendingRequests.set('req-1', pending);
    mockGet.mockResolvedValueOnce('req-1');

    const result = await cancelAiChatSessionRequest('session-1');

    expect(result).toBe(true);
    expect(mockEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('DEL', KEYS[1])"),
      1,
      'session:processing:session-1',
      'req-1',
    );
    expect(mockDel).not.toHaveBeenCalled();
    expect(mockLpush).toHaveBeenCalledWith(
      'ipc:web:user-1:cancel',
      expect.stringContaining('"type":"cancel"'),
    );
    expect(mockLpush).toHaveBeenCalledWith(
      'ipc:web:user-1:cancel',
      expect.stringContaining('"requestId":"req-1"'),
    );
    expect(mockSettleBillingReservation).toHaveBeenCalledWith({
      requestId: 'req-1',
      runtime: undefined,
      promptTokens: 0,
      completionTokens: 0,
    });
    expect(mockReleaseLocalAgent).toHaveBeenCalledWith('web:user-1');
    expect(pending.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-1',
        status: 'error',
        publicReasonCode: 'user_stop',
      }),
    );
    expect(pendingRequests.has('req-1')).toBe(false);
  });

  it('returns false when no request is currently processing', async () => {
    mockGet.mockResolvedValueOnce(null);

    const result = await cancelAiChatSessionRequest('session-1');

    expect(result).toBe(false);
    expect(mockDel).not.toHaveBeenCalled();
    expect(mockLpush).not.toHaveBeenCalled();
  });

  it('can cancel by processing marker and account id after pending memory is gone', async () => {
    mockGet.mockResolvedValueOnce('req-restore');

    const result = await cancelAiChatSessionRequest('session-1', 'web:user-1');

    expect(result).toBe(true);
    expect(mockEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('DEL', KEYS[1])"),
      1,
      'session:processing:session-1',
      'req-restore',
    );
    expect(mockDel).not.toHaveBeenCalled();
    expect(mockLpush).toHaveBeenCalledWith(
      'ipc:web:user-1:cancel',
      expect.stringContaining('"requestId":"req-restore"'),
    );
    expect(mockSettleBillingReservation).not.toHaveBeenCalled();
  });
});

describe('global agent concurrency gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLindex.mockReset();
  });

  it('exposes member and normal wait queues separately', async () => {
    const state = (
      await import('./ipc-worker.js')
    ).__getGlobalAgentConcurrencyStateForTests();

    expect(state.limit).toBe(10);
    expect(state.memberQueue).toContain(':member');
    expect(state.normalQueue).toContain(':normal');
    expect(state.memberQueue).not.toBe(state.normalQueue);
  });

  it('peeks member waiters before normal waiters', async () => {
    mockLindex
      .mockResolvedValueOnce('member-request')
      .mockResolvedValueOnce('normal-request');

    const next = await (
      await import('./ipc-worker.js')
    ).__peekNextGlobalAgentWaiterForTests();

    expect(next).toBe('member-request');
    expect(mockLindex).toHaveBeenCalledWith(
      'agent:concurrency:wait:member',
      -1,
    );
    expect(mockLindex).not.toHaveBeenCalledWith(
      'agent:concurrency:wait:normal',
      -1,
    );
  });

  it('falls back to normal waiters when there is no member waiter', async () => {
    mockLindex
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('normal-request');

    const next = await (
      await import('./ipc-worker.js')
    ).__peekNextGlobalAgentWaiterForTests();

    expect(next).toBe('normal-request');
    expect(mockLindex).toHaveBeenCalledWith(
      'agent:concurrency:wait:normal',
      -1,
    );
  });

  it('releases the stored concurrency slot when cancelling a pending AI chat', async () => {
    const pendingRequests = (
      await import('./ipc-worker.js')
    ).__getPendingAiChatRequestsForTests();
    pendingRequests.clear();
    const pending = createPending({ concurrencySlotId: 'slot-1' });
    pendingRequests.set('req-1', pending);
    mockGet.mockResolvedValueOnce('req-1');

    const result = await cancelAiChatSessionRequest('session-1');

    expect(result).toBe(true);
    expect(mockZrem).toHaveBeenCalledWith('agent:concurrency:active', 'slot-1');
  });
});

describe('runtime lease lifecycle for submitted inbox requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpcWorkerForTests();
    mockEval.mockResolvedValue(1);
    mockLpush.mockResolvedValue(1);
    vi.mocked(getUserByAccountId).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(getMembershipOverview).mockResolvedValue({
      active: true,
    } as never);
  });

  it('retains AI Chat runtime and keeps the lease after waitForResponse=false accepted', async () => {
    const result = await submitAiChatInboxRequest({
      accountId: 'account-1',
      userMessage: 'hi',
      history: [],
      sessionId: 'session-1',
      llmRuntime: effectiveRuntime,
      waitForResponse: false,
    });

    expect(result).toEqual({
      requestId: expect.stringMatching(/^aichat-/),
      status: 'success',
      text: '',
    });
    expect(mockRetainLocalAgent).toHaveBeenCalledWith('account-1');
    expect(mockReleaseLocalAgent).not.toHaveBeenCalled();
    expect(__getPendingAiChatRequestsForTests().get(result.requestId)).toEqual(
      expect.objectContaining({
        localAgentLeaseAccountId: 'account-1',
      }),
    );
  });

  it('releases normal inbox runtime lease when enqueue fails', async () => {
    mockLpush.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      submitInboxRequest({
        accountId: 'account-1',
        type: 'chat',
        userMessage: 'hi',
        history: [],
        llmRuntime: effectiveRuntime,
      }),
    ).rejects.toThrow('redis down');

    expect(mockRetainLocalAgent).toHaveBeenCalledWith('account-1');
    expect(mockReleaseLocalAgent).toHaveBeenCalledWith('account-1');
  });
});
