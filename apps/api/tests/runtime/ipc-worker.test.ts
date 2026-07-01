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
  mockEnsureLocalAgentRunning,
  mockReleaseLocalAgent,
  mockRetainLocalAgent,
  mockOnLocalAgentProcessExit,
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
  mockEnsureLocalAgentRunning: vi.fn(async () => undefined),
  mockReleaseLocalAgent: vi.fn(async () => undefined),
  mockRetainLocalAgent: vi.fn((accountId: string) => accountId),
  mockOnLocalAgentProcessExit: vi.fn(),
  mockRpop: vi.fn(),
  mockRpush: vi.fn(async () => 1),
  mockSettleBillingReservation: vi.fn(async () => 0),
  mockZrem: vi.fn(async () => 1),
}));

vi.mock('../../src/infrastructure/db.js', () => ({
  expireUserBonusBalanceBefore: vi.fn(async () => ({
    expired: 0,
    totalCoinsExpired: 0,
  })),
  getMembershipOverview: vi.fn(async () => ({ active: false })),
  getUserByAccountId: vi.fn(),
  getUserById: vi.fn(),
}));

vi.mock('../../src/infrastructure/redis.js', () => ({
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

vi.mock('../../src/infrastructure/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: mockLoggerInfo,
    warn: vi.fn(),
  },
}));

vi.mock('../../src/runtime/ipc-outbox-handler.js', () => ({
  processOutboxPayload: vi.fn(),
}));

vi.mock('../../src/runtime/ipc-ai-chat-outbox-handler.js', () => ({
  processAiChatOutboxPayload: vi.fn(),
}));

vi.mock('../../src/runtime/local-runner.js', () => ({
  ensureLocalAgentRunning: mockEnsureLocalAgentRunning,
  releaseLocalAgent: mockReleaseLocalAgent,
  retainLocalAgent: mockRetainLocalAgent,
  onLocalAgentProcessExit: mockOnLocalAgentProcessExit,
}));

vi.mock('../../src/modules/billing/plans.js', () => ({
  reserveBillingForRequest: vi.fn(),
  settleBillingReservation: mockSettleBillingReservation,
}));

vi.mock('../../src/modules/account/account-service.js', () => ({
  FREE_WECHAT_UNSUPPORTED_MESSAGE: 'free unsupported',
}));

vi.mock('../../src/modules/chat/web-chat-runtime.js', () => ({
  getUserIdFromWebChatRuntimeId: vi.fn((value: string) =>
    value.startsWith('web:') ? value.slice(4) : null,
  ),
}));

vi.mock('../../src/modules/system/system-config.js', () => ({
  getAgentConcurrencyLimit: vi.fn(async () => 10),
  resolveUserLlmRuntime: vi.fn(),
}));

import {
  _resetIpcWorkerForTests,
  __getPendingAiChatRequestsForTests,
  cancelAiChatSessionRequest,
  startIpcWorker,
  submitAiChatInboxRequest,
  submitInboxRequest,
} from '../../src/runtime/ipc-worker.js';
import type { PendingInboxRequest } from '../../src/runtime/ipc-payloads.js';
import { processAiChatOutboxPayload } from '../../src/runtime/ipc-ai-chat-outbox-handler.js';
import {
  getMembershipOverview,
  getUserByAccountId,
  getUserById,
} from '../../src/infrastructure/db.js';

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
      await import('../../src/runtime/ipc-worker.js')
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
    // 取消不再就地 settle(0,0)：预留保留为 charge_state='pending'，
    // 由 billing-sweeper 按 daemon 中断响应落库的真实 usage 兜底补结算，避免取消前 token 免费。
    expect(mockSettleBillingReservation).not.toHaveBeenCalled();
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
      await import('../../src/runtime/ipc-worker.js')
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
      await import('../../src/runtime/ipc-worker.js')
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
      await import('../../src/runtime/ipc-worker.js')
    ).__peekNextGlobalAgentWaiterForTests();

    expect(next).toBe('normal-request');
    expect(mockLindex).toHaveBeenCalledWith(
      'agent:concurrency:wait:normal',
      -1,
    );
  });

  it('releases the stored concurrency slot when cancelling a pending AI chat', async () => {
    const pendingRequests = (
      await import('../../src/runtime/ipc-worker.js')
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

describe('per-user metered concurrency gate', () => {
  const lowBalanceEntitlement = {
    userId: 'user-1',
    membershipActive: true,
    planKey: 'clarity',
    planRank: 1,
    hasPaidMembership: true,
    hasPriorityQueue: true,
    canUseCustomModel: true,
    canUseWechatClaw: false,
    wallet: {
      purchasedCoins: 1,
      bonusCoins: 0,
      reservedCoins: 0,
      availableCoins: 1, // < 5 阈值 → 进入 per-user 并发门
      inArrears: false,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpcWorkerForTests();
    mockLpush.mockResolvedValue(1);
  });

  it('低余额用户名额已满时拒绝并发的 metered 请求', async () => {
    mockEval.mockResolvedValueOnce(0); // per-user acquire：名额已满

    await expect(
      submitAiChatInboxRequest({
        accountId: 'web:user-1',
        userMessage: 'hi',
        history: [],
        sessionId: 'session-1',
        llmRuntime: effectiveRuntime, // metered
        entitlementSnapshot: lowBalanceEntitlement as never,
        waitForResponse: false,
      }),
    ).rejects.toThrow('积分不足以同时进行多个解读');

    // 被拒发生在抢全局槽之前：只有 per-user acquire 这一次 eval，且未入全局等待队列。
    expect(mockEval).toHaveBeenCalledTimes(1);
    expect(mockLpush).not.toHaveBeenCalled();
  });
});

describe('runtime lease lifecycle for submitted inbox requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpcWorkerForTests();
    mockEval.mockResolvedValue(1);
    mockLpush.mockResolvedValue(1);
    vi.mocked(getUserByAccountId).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(getUserById).mockResolvedValue({
      id: 'user-1',
      // 健康余额：跳过 per-user 低余额并发门，本组用例只验证全局并发/租约生命周期。
      purchased_coins: 100,
      bonus_coins: 0,
      reserved_coins: 0,
    } as never);
    vi.mocked(getMembershipOverview).mockResolvedValue({
      active: true,
      membership: { plan_key: 'fateclaw_insight' },
    } as never);
  });

  it('accepts AI Chat after wait queue registration and keeps the lease', async () => {
    let releaseGate: ((value: unknown) => void) | undefined;
    let releaseRuntime: (() => void) | undefined;
    mockEval.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseGate = resolve;
        }),
    );
    mockEnsureLocalAgentRunning.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseRuntime = resolve;
        }),
    );

    const result = await submitAiChatInboxRequest({
      accountId: 'web:user-1',
      userMessage: 'hi',
      history: [],
      sessionId: 'session-1',
      llmRuntime: effectiveRuntime,
      authorizedSkillBundleIds: ['bundle-bazi'],
      authorizedWorkflowSkillIds: ['snapshot-bazi'],
      waitForResponse: false,
    });

    expect(result).toEqual({
      requestId: expect.stringMatching(/^aichat-/),
      status: 'success',
      text: '',
    });
    expect(mockReleaseLocalAgent).not.toHaveBeenCalled();
    expect(mockLpush).toHaveBeenCalledWith(
      'agent:concurrency:wait:member',
      result.requestId,
    );
    expect(getUserByAccountId).not.toHaveBeenCalled();
    expect(mockEnsureLocalAgentRunning).toHaveBeenCalledWith('web:user-1');
    expect(mockRetainLocalAgent).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(releaseGate).toBeTypeOf('function');
    });
    releaseGate?.([1, 'member']);
    expect(mockRetainLocalAgent).not.toHaveBeenCalled();
    releaseRuntime?.();
    await vi.waitFor(() => {
      expect(mockRetainLocalAgent).toHaveBeenCalledWith('web:user-1');
      expect(mockLpush).toHaveBeenCalledWith(
        expect.stringMatching(/^ipc:web:user-1:inbox:member$/),
        expect.stringContaining('"authorizedSkillBundleIds":["bundle-bazi"]'),
      );
    });
    expect(mockLpush).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('"authorizedSkillBundleIds":["bundle-bazi"]'),
    );
    expect(mockLpush).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('"authorizedWorkflowSkillIds":["snapshot-bazi"]'),
    );
    expect(__getPendingAiChatRequestsForTests().get(result.requestId)).toEqual(
      expect.objectContaining({
        localAgentLeaseAccountId: 'web:user-1',
      }),
    );
  });

  it('releases normal inbox runtime lease when enqueue fails', async () => {
    vi.mocked(getMembershipOverview).mockResolvedValueOnce({
      active: true,
      membership: { plan_key: 'fateclaw_clarity' },
    } as never);
    mockLpush.mockRejectedValueOnce(new Error('redis down'));

    // 微信 Claw 停用后，autoDeliver 默认 true 的请求会在门禁处被拒；
    // 只有 autoDeliver:false（不投递微信，如取消/AI Chat 旁路）才会真正走到入队，
    // 这条用例验证入队失败时本地 agent 租约被释放。
    await expect(
      submitInboxRequest({
        accountId: 'account-1',
        type: 'chat',
        userMessage: 'hi',
        history: [],
        llmRuntime: effectiveRuntime,
        autoDeliver: false,
      }),
    ).rejects.toThrow('redis down');

    expect(mockRetainLocalAgent).toHaveBeenCalledWith('account-1');
    expect(mockReleaseLocalAgent).toHaveBeenCalledWith('account-1');
  });

  it('does not allow Insight priority queue entitlement to auto-deliver WeChat requests', async () => {
    await expect(
      submitInboxRequest({
        accountId: 'account-1',
        type: 'chat',
        userMessage: 'hi',
        history: [],
        llmRuntime: effectiveRuntime,
      }),
    ).rejects.toThrow('free unsupported');

    expect(mockRetainLocalAgent).not.toHaveBeenCalled();
    expect(mockLpush).not.toHaveBeenCalled();
  });
});

describe('local agent-runtime process exit notifies in-flight AI Chat requests', () => {
  beforeEach(() => {
    _resetIpcWorkerForTests();
    mockOnLocalAgentProcessExit.mockClear();
    vi.mocked(processAiChatOutboxPayload).mockReset();
    vi.mocked(processAiChatOutboxPayload).mockResolvedValue(undefined);
  });

  it('registers a crash handler with local-runner on startup', () => {
    startIpcWorker([]);
    expect(mockOnLocalAgentProcessExit).toHaveBeenCalledTimes(1);
    expect(mockOnLocalAgentProcessExit.mock.calls[0][0]).toBeTypeOf('function');
  });

  it('fails in-flight requests only for the crashed account, with a detailed error and friendly public message', async () => {
    startIpcWorker([]);
    const handler = mockOnLocalAgentProcessExit.mock.calls[0][0] as (
      accountId: string,
      info: {
        reason: 'exit' | 'error';
        code: number | null;
        signal: string | null;
      },
    ) => void;

    const pending = __getPendingAiChatRequestsForTests();
    pending.set(
      'req-crash-1',
      createPending({ accountId: 'web:crash-acct', sessionId: 'session-a' }),
    );
    pending.set(
      'req-other',
      createPending({ accountId: 'web:other-acct', sessionId: 'session-b' }),
    );

    handler('web:crash-acct', { reason: 'exit', code: 137, signal: null });

    await vi.waitFor(() => {
      expect(processAiChatOutboxPayload).toHaveBeenCalledTimes(1);
    });

    const [payload, accountId] = vi.mocked(processAiChatOutboxPayload).mock
      .calls[0] as [Record<string, unknown>, string];
    expect(accountId).toBe('web:crash-acct');
    expect(payload.requestId).toBe('req-crash-1');
    expect(payload.status).toBe('error');
    expect(payload.publicReasonCode).toBe('agent_process_exited');
    // 详细诊断信息（退出码/OOM 提示）应保留在内部 error 字段，不直接暴露给用户文案。
    expect(payload.error).toContain('137');
    expect(payload.error).toContain('OOM');
    expect(payload.publicErrorText).not.toContain('137');

    // 未受影响账号的在途请求不应被处理，也不应从表中删除。
    expect(pending.has('req-other')).toBe(true);
  });

  it('does nothing when the crashed account has no in-flight requests', async () => {
    startIpcWorker([]);
    const handler = mockOnLocalAgentProcessExit.mock.calls[0][0] as (
      accountId: string,
      info: { reason: 'exit'; code: number | null; signal: string | null },
    ) => void;

    handler('web:idle-acct', { reason: 'exit', code: 0, signal: null });
    await Promise.resolve();

    expect(processAiChatOutboxPayload).not.toHaveBeenCalled();
  });
});
