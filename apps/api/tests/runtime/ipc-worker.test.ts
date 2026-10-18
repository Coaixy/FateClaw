import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeRuntimeIpc, encodeRuntimeIpc } from '#runtime/ipc-security';
import { getRedis } from '#infrastructure/redis';

const {
  mockGet,
  mockDel,
  mockEval,
  mockLindex,
  mockLlen,
  mockLpush,
  mockLrem,
  mockDuplicate,
  mockRpoplpush,
  mockLoggerError,
  mockLoggerInfo,
  mockLoggerWarn,
  mockEnsureLocalAgentRunning,
  mockReleaseLocalAgent,
  mockRetainLocalAgent,
  mockOnLocalAgentProcessExit,
  mockRpop,
  mockRpush,
  mockSettleBillingReservation,
  mockZadd,
  mockZrange,
  mockZrem,
  mockHset,
  mockHdel,
  mockPexpire,
} = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockDel: vi.fn(async () => 1),
  mockEval: vi.fn(async () => 1),
  mockLindex: vi.fn(),
  mockLlen: vi.fn(async () => 0),
  mockLpush: vi.fn(async () => 1),
  mockLrem: vi.fn(async () => 1),
  mockDuplicate: vi.fn(),
  mockRpoplpush: vi.fn(async () => null),
  mockLoggerError: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockEnsureLocalAgentRunning: vi.fn(async () => undefined),
  mockReleaseLocalAgent: vi.fn(async () => undefined),
  mockRetainLocalAgent: vi.fn((accountId: string) => accountId),
  mockOnLocalAgentProcessExit: vi.fn(),
  mockRpop: vi.fn(),
  mockRpush: vi.fn(async () => 1),
  mockSettleBillingReservation: vi.fn(async () => 0),
  mockZadd: vi.fn(async () => 1),
  mockZrange: vi.fn(async () => [] as string[]),
  mockZrem: vi.fn(async () => 1),
  mockHset: vi.fn(async () => 1),
  mockHdel: vi.fn(async () => 1),
  mockPexpire: vi.fn(async () => 1),
}));

vi.mock('#infrastructure/repositories/agent-requests-repository', () => ({
  admitAgentRequest: vi.fn(async () => 'execution-1'),
  markAgentRequestDispatched: vi.fn(async () => true),
  requestAgentCancellation: vi.fn(async () => undefined),
  persistAgentFailure: vi.fn(async (_id, payload) => payload),
}));

vi.mock('#infrastructure/db', () => ({
  expireUserBonusBalanceBefore: vi.fn(async () => ({
    expired: 0,
    totalCoinsExpired: 0,
  })),
  getMembershipOverview: vi.fn(async () => ({ active: false })),
  getUserByAccountId: vi.fn(),
  getUserById: vi.fn(),
}));

vi.mock('#infrastructure/redis', () => ({
  getRedis: vi.fn(() => ({
    duplicate: mockDuplicate,
    get: mockGet,
    del: mockDel,
    eval: mockEval,
    lindex: mockLindex,
    llen: mockLlen,
    lpush: mockLpush,
    lrem: mockLrem,
    rpop: mockRpop,
    rpush: mockRpush,
    rpoplpush: mockRpoplpush,
    zadd: mockZadd,
    zrange: mockZrange,
    zrem: mockZrem,
    hset: mockHset,
    hdel: mockHdel,
    pexpire: mockPexpire,
  })),
}));

vi.mock('#infrastructure/config', () => ({
  JWT_SECRET: 'synthetic-runtime-transport-root',
  LOW_BALANCE_CONCURRENCY_THRESHOLD_COINS: 5,
}));

vi.mock('#infrastructure/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: mockLoggerError,
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
  },
}));

vi.mock('#runtime/ipc-outbox-handler', () => ({
  processOutboxPayload: vi.fn(),
}));

vi.mock('#runtime/paipan-tool-handler', () => ({
  processPaipanToolPayload: vi.fn(),
}));

vi.mock('#runtime/ipc-ai-chat-outbox-handler', () => ({
  processAiChatOutboxPayload: vi.fn(),
}));

vi.mock('#runtime/local-runner', () => ({
  ensureLocalAgentRunning: mockEnsureLocalAgentRunning,
  releaseLocalAgent: mockReleaseLocalAgent,
  retainLocalAgent: mockRetainLocalAgent,
  onLocalAgentProcessExit: mockOnLocalAgentProcessExit,
}));

vi.mock('#modules/billing/plans', () => ({
  // 非会员加价直通：测试关注并发/租约生命周期，不关心价格改写细节。
  applyNonMemberPricingMarkup: vi.fn(
    (runtime: unknown, _membershipActive: boolean) => runtime,
  ),
  reserveBillingForRequest: vi.fn(),
  settleBillingReservation: mockSettleBillingReservation,
}));

vi.mock('#modules/account/account-service', () => ({
  FREE_WECHAT_UNSUPPORTED_MESSAGE: 'free unsupported',
}));

vi.mock('#modules/chat/web-chat-runtime', () => ({
  getUserIdFromWebChatRuntimeId: vi.fn((value: string) =>
    value.startsWith('web:') ? value.slice(4) : null,
  ),
}));

vi.mock('#modules/system/system-config', () => ({
  getAgentConcurrencyLimit: vi.fn(async () => 10),
  resolveUserLlmRuntime: vi.fn(),
}));

import {
  _resetIpcWorkerForTests,
  __getPendingAiChatRequestsForTests,
  addAccountListener,
  cancelAiChatSessionRequest,
  getIpcWorkerStatus,
  removeAccountListener,
  startIpcWorker,
  submitAiChatInboxRequest,
  submitInboxRequest,
} from '#runtime/ipc-worker';
import type { PendingInboxRequest } from '#runtime/ipc-payloads';
import { processAiChatOutboxPayload } from '#runtime/ipc-ai-chat-outbox-handler';
import { processOutboxPayload } from '#runtime/ipc-outbox-handler';
import { processPaipanToolPayload } from '#runtime/paipan-tool-handler';
import {
  getMembershipOverview,
  getUserByAccountId,
  getUserById,
} from '#infrastructure/db';

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
    localAgentLeaseId: 'web:user-1',
    resolve: vi.fn(),
    reject: vi.fn(),
    timeout: setTimeout(() => undefined, 10_000),
    ...overrides,
  };
}

beforeEach(() => {
  mockDuplicate.mockImplementation(() => ({
    on: vi.fn(),
    connect: vi.fn(async () => undefined),
    brpop: vi.fn(() => new Promise<null>(() => {})),
    blmove: vi.fn(() => new Promise<null>(() => {})),
    disconnect: vi.fn(),
  }));
});

describe('Redis IPC listener lifecycle', () => {
  const accountId = 'web:listener-user';
  const queue = `ipc:${accountId}:outbox`;
  const payload = { type: 'progress', text: 'synthetic progress' };

  function createConsumer() {
    return {
      on: vi.fn(),
      connect: vi.fn<() => Promise<void>>(async () => undefined),
      brpop: vi.fn(async (): Promise<[string, string] | null> => {
        removeAccountListener(accountId);
        return [
          queue,
          encodeRuntimeIpc(accountId, queue, JSON.stringify(payload)),
        ];
      }),
      quit: vi.fn(async () => 'OK'),
      disconnect: vi.fn(),
    };
  }

  function createAiConsumer() {
    return {
      on: vi.fn(),
      connect: vi.fn(async () => undefined),
      blmove: vi.fn(() => new Promise<null>(() => {})),
      disconnect: vi.fn(),
    };
  }

  beforeEach(() => {
    _resetIpcWorkerForTests();
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDuplicate.mockReset();
    mockLindex.mockReset();
    mockLindex.mockResolvedValue(null);
    mockRpoplpush.mockResolvedValue(null);
  });

  afterEach(async () => {
    _resetIpcWorkerForTests();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  it('waits for the lazy connection before consuming and releases it on stop', async () => {
    const consumer = createConsumer();
    let ready!: () => void;
    consumer.connect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    mockDuplicate
      .mockReturnValueOnce(consumer)
      .mockReturnValueOnce(createAiConsumer());

    addAccountListener(accountId);
    await vi.advanceTimersByTimeAsync(0);

    expect(consumer.connect).toHaveBeenCalledOnce();
    expect(consumer.brpop).not.toHaveBeenCalled();
    expect(processOutboxPayload).not.toHaveBeenCalled();

    ready();
    await vi.advanceTimersByTimeAsync(0);

    expect(consumer.brpop).toHaveBeenCalledWith(
      queue,
      `ipc:${accountId}:paipan`,
      1,
    );
    expect(processOutboxPayload).toHaveBeenCalledWith(
      expect.objectContaining(payload),
      accountId,
      expect.any(Map),
    );
    expect(consumer.disconnect).toHaveBeenCalledOnce();
    expect(consumer.quit).not.toHaveBeenCalled();
    expect(getIpcWorkerStatus().listenerAccounts).toEqual([]);
    expect(mockLoggerError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('routes chart tool requests through the existing account listener', async () => {
    const consumer = createConsumer();
    const toolQueue = `ipc:${accountId}:paipan`;
    const request = { rpcId: 'synthetic-rpc', operation: { mode: 'catalog' } };
    consumer.brpop.mockImplementationOnce(async () => {
      removeAccountListener(accountId);
      return [
        toolQueue,
        encodeRuntimeIpc(accountId, toolQueue, JSON.stringify(request)),
      ];
    });
    mockDuplicate
      .mockReturnValueOnce(consumer)
      .mockReturnValueOnce(createAiConsumer());
    addAccountListener(accountId);
    await vi.advanceTimersByTimeAsync(0);
    expect(processPaipanToolPayload).toHaveBeenCalledWith(
      expect.objectContaining(request),
      accountId,
    );
    expect(processOutboxPayload).not.toHaveBeenCalled();
    expect(processAiChatOutboxPayload).not.toHaveBeenCalled();
  });

  it.each(['connect', 'brpop'] as const)(
    'preserves a %s failure, releases the connection and consumes after retry',
    async (phase) => {
      const failed = createConsumer();
      const recovered = createConsumer();
      const original = new Error(`synthetic ${phase} failure`);
      failed.brpop.mockRejectedValue(new Error('synthetic read failure'));
      failed[phase].mockRejectedValueOnce(original);
      failed.quit.mockRejectedValueOnce(
        new Error(
          "Stream isn't writeable and enableOfflineQueue options is false",
        ),
      );
      mockDuplicate
        .mockReturnValueOnce(failed)
        .mockReturnValueOnce(createAiConsumer())
        .mockReturnValueOnce(recovered)
        .mockReturnValueOnce(createAiConsumer());

      addAccountListener(accountId);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockLoggerError).toHaveBeenCalledWith(
        { accountId, err: original, retry: 1 },
        'Redis IPC 监听异常退出，准备重启',
      );
      expect(failed.disconnect).toHaveBeenCalledOnce();
      expect(getIpcWorkerStatus().listenerAccounts).toEqual([]);
      expect(mockDuplicate).toHaveBeenCalledTimes(2);
      if (phase === 'connect') expect(failed.brpop).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);

      expect(mockDuplicate).toHaveBeenCalledTimes(4);
      expect(processOutboxPayload).toHaveBeenCalledWith(
        expect.objectContaining(payload),
        accountId,
        expect.any(Map),
      );
      expect(recovered.disconnect).toHaveBeenCalledOnce();
      expect(getIpcWorkerStatus().listenerAccounts).toEqual([]);
      expect(mockLoggerError).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

// Only use an explicitly supplied disposable Redis, never the application source.
const testRedisUrl = process.env.FATECLAW_TEST_REDIS_URL;
it.skipIf(!testRedisUrl)(
  'keeps both real IPC consumers blocking and delivers again after reconnecting',
  async () => {
    _resetIpcWorkerForTests();
    vi.clearAllMocks();
    const originalGetRedis = vi.mocked(getRedis).getMockImplementation()!;
    const commands = new Redis(testRedisUrl!, {
      maxRetriesPerRequest: 1,
      commandTimeout: 5_000,
      connectTimeout: 5_000,
      enableOfflineQueue: false,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    const duplicate = vi.spyOn(commands, 'duplicate');
    const inspectProcessing = vi.spyOn(commands, 'lindex');
    const accountId = `web:test-${randomUUID()}`;
    const queue = `ipc:${accountId}:outbox`;
    const aiQueue = `ipc:${accountId}:ai-chat:outbox`;
    const payload = { type: 'progress', text: 'synthetic progress' };
    const waitOptions = { timeout: 3_000, interval: 25 };
    try {
      await commands.connect();
      vi.mocked(getRedis).mockReturnValue(commands);
      // Exercise readiness with nonzero server latency as well as blocking reads.
      await commands.call('CLIENT', 'PAUSE', 50, 'ALL');
      addAccountListener(accountId);

      // A second processing check proves BLMOVE completed an idle blocking cycle.
      await vi.waitFor(() => {
        expect(inspectProcessing.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(duplicate).toHaveBeenCalledTimes(2);
        for (const result of duplicate.mock.results) {
          expect(result.value.status).toBe('ready');
        }
      }, waitOptions);
      expect(mockLoggerError).not.toHaveBeenCalled();

      const failure = new Error('synthetic consumer connection failure');
      const consumer = duplicate.mock.results[0].value;
      for (const result of duplicate.mock.results) {
        result.value.emit('error', failure);
      }
      expect(mockLoggerWarn).toHaveBeenCalledTimes(2);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        {
          accountId,
          err: {
            type: failure.name,
            message: failure.message,
            stack: failure.stack,
          },
        },
        'Redis IPC 连接异常',
      );

      for (let round = 1; round <= 2; round += 1) {
        await commands.lpush(
          queue,
          encodeRuntimeIpc(accountId, queue, JSON.stringify(payload)),
        );
        await commands.lpush(
          aiQueue,
          encodeRuntimeIpc(accountId, aiQueue, JSON.stringify(payload)),
        );
        await vi.waitFor(async () => {
          expect(processOutboxPayload).toHaveBeenCalledTimes(round);
          expect(processAiChatOutboxPayload).toHaveBeenCalledTimes(round);
          expect(processOutboxPayload).toHaveBeenLastCalledWith(
            expect.objectContaining(payload),
            accountId,
            expect.any(Map),
          );
          expect(processAiChatOutboxPayload).toHaveBeenLastCalledWith(
            expect.objectContaining(payload),
            accountId,
            expect.any(Map),
          );
          expect(await commands.llen(`${aiQueue}:processing`)).toBe(0);
        }, waitOptions);

        if (round === 1) {
          consumer.disconnect();
          await vi.waitFor(() => {
            expect(duplicate).toHaveBeenCalledTimes(4);
            expect(duplicate.mock.results[2].value.status).toBe('ready');
            expect(duplicate.mock.results[3].value.status).toBe('ready');
          }, waitOptions);
          expect(mockLoggerError).toHaveBeenCalledTimes(1);
        }
      }
      removeAccountListener(accountId);
      await vi.waitFor(() => {
        expect(getIpcWorkerStatus().listenerAccounts).toEqual([]);
      }, waitOptions);
      expect(mockLoggerError).toHaveBeenCalledTimes(1);
    } finally {
      _resetIpcWorkerForTests();
      vi.mocked(getRedis).mockImplementation(originalGetRedis);
      try {
        await commands.del(queue, aiQueue, `${aiQueue}:processing`);
      } finally {
        commands.disconnect();
      }
    }
  },
  15_000,
);

describe('cancelAiChatSessionRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('releases the busy marker and enqueues a cancel request for the active AI chat', async () => {
    const pendingRequests = (
      await import('#runtime/ipc-worker')
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
    expect(
      JSON.parse(
        decodeRuntimeIpc(
          'web:user-1',
          mockLpush.mock.calls[0][0],
          mockLpush.mock.calls[0][1],
        ),
      ),
    ).toMatchObject({ type: 'cancel', requestId: 'req-1' });
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
    expect(
      JSON.parse(
        decodeRuntimeIpc(
          'web:user-1',
          mockLpush.mock.calls[0][0],
          mockLpush.mock.calls[0][1],
        ),
      ),
    ).toMatchObject({ requestId: 'req-restore' });
    expect(mockSettleBillingReservation).not.toHaveBeenCalled();
  });
});

describe('global agent concurrency gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLindex.mockReset();
    // mockReset 清掉 mockResolvedValueOnce 排队值，避免用例间泄漏。
    mockZrange.mockReset();
    mockZrange.mockResolvedValue([]);
  });

  it('exposes member and normal wait queues separately', async () => {
    const state = (
      await import('#runtime/ipc-worker')
    ).__getGlobalAgentConcurrencyStateForTests();

    expect(state.limit).toBe(10);
    expect(state.memberQueue).toContain(':member');
    expect(state.normalQueue).toContain(':normal');
    expect(state.memberQueue).not.toBe(state.normalQueue);
  });

  it('peeks member waiters before normal waiters', async () => {
    mockZrange
      .mockResolvedValueOnce(['member-request'])
      .mockResolvedValueOnce(['normal-request']);

    const next = await (
      await import('#runtime/ipc-worker')
    ).__peekNextGlobalAgentWaiterForTests();

    expect(next).toBe('member-request');
    expect(mockZrange).toHaveBeenCalledWith(
      'agent:concurrency:waitq:member',
      0,
      0,
    );
    expect(mockZrange).not.toHaveBeenCalledWith(
      'agent:concurrency:waitq:normal',
      0,
      0,
    );
  });

  it('falls back to normal waiters when there is no member waiter', async () => {
    mockZrange
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['normal-request']);

    const next = await (
      await import('#runtime/ipc-worker')
    ).__peekNextGlobalAgentWaiterForTests();

    expect(next).toBe('normal-request');
    expect(mockZrange).toHaveBeenCalledWith(
      'agent:concurrency:waitq:normal',
      0,
      0,
    );
  });

  it('releases the stored concurrency slot when cancelling a pending AI chat', async () => {
    const pendingRequests = (
      await import('#runtime/ipc-worker')
    ).__getPendingAiChatRequestsForTests();
    pendingRequests.clear();
    const pending = createPending({ concurrencySlotId: 'slot-1' });
    pendingRequests.set('req-1', pending);
    mockGet.mockResolvedValueOnce('req-1');

    const result = await cancelAiChatSessionRequest('session-1');

    expect(result).toBe(true);
    expect(mockEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('ZREM', KEYS[1]"),
      2,
      'agent:concurrency:active',
      'agent:runtime:owner:slot-1',
      'slot-1',
      'agent:capacity:changed',
      '',
    );
  });
});

describe('per-user metered concurrency gate', () => {
  const lowBalanceEntitlement = {
    userId: 'user-1',
    membershipActive: true,
    hasPriorityQueue: true,
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
      membership: { plan_key: 'membership' },
    } as never);
  });

  it('accepts durably before startup and takes no global slot until the runtime is ready', async () => {
    let ready!: () => void;
    mockEnsureLocalAgentRunning.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    const result = await submitAiChatInboxRequest({
      accountId: 'web:user-1',
      userMessage: 'hi',
      history: [],
      sessionId: 'session-1',
      llmRuntime: effectiveRuntime,
      authorizedSkillIds: ['skill-bazi'],
      waitForResponse: false,
    });
    await vi.waitFor(() => expect(ready).toBeTypeOf('function'));
    expect(mockZadd).not.toHaveBeenCalled();
    expect(mockRetainLocalAgent).not.toHaveBeenCalled();
    ready();
    await vi.waitFor(() =>
      expect(mockLpush).toHaveBeenCalledWith(
        'ipc:web:user-1:inbox:member',
        expect.any(String),
      ),
    );
    expect(
      JSON.parse(
        decodeRuntimeIpc(
          'web:user-1',
          mockLpush.mock.calls[0][0],
          mockLpush.mock.calls[0][1],
        ),
      ),
    ).toMatchObject({ authorizedSkillIds: ['skill-bazi'] });
    expect(
      __getPendingAiChatRequestsForTests().get(result.requestId)
        ?.localAgentLeaseId,
    ).toBe('web:user-1');
  });
  it('releases an unqueued runtime and leaves failed persistence eligible for durable recovery', async () => {
    const requests =
      await import('#infrastructure/repositories/agent-requests-repository');
    vi.mocked(requests.markAgentRequestDispatched).mockResolvedValueOnce(false);
    vi.mocked(requests.persistAgentFailure).mockRejectedValueOnce(
      new Error('synthetic database failure'),
    );
    const result = await submitAiChatInboxRequest({
      accountId: 'web:user-1',
      userMessage: 'synthetic',
      history: [],
      sessionId: 'session-1',
      llmRuntime: effectiveRuntime,
      waitForResponse: false,
    });
    await vi.waitFor(() =>
      expect(__getPendingAiChatRequestsForTests().has(result.requestId)).toBe(
        false,
      ),
    );
    expect(mockReleaseLocalAgent).toHaveBeenCalledWith('web:user-1');
    expect(mockLpush).not.toHaveBeenCalled();
  });

  it('releases normal inbox runtime lease when enqueue fails', async () => {
    vi.mocked(getMembershipOverview).mockResolvedValueOnce({
      active: true,
      membership: { plan_key: 'membership' },
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

  it('does not auto-deliver WeChat requests for an active member', async () => {
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
      'req-queued',
      createPending({
        accountId: 'web:crash-acct',
        sessionId: 'queued',
        localAgentLeaseId: undefined,
      }),
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
    // text 是 validateResponsePayload 的必填字段，漏掉会导致真实校验直接判定
    // payload 无效、这条兜底静默失效（此测试 mock 掉了校验，之前没能抓住这个问题）。
    expect(payload.text).toBeTypeOf('string');
    expect(payload.text).toBe(payload.publicErrorText);
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
