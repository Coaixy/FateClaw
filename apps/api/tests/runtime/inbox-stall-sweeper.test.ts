import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeRuntimeIpc } from '../../src/runtime/ipc-security.js';

const {
  mockLindex,
  mockRpoplpush,
  mockLrem,
  mockScan,
  mockLrange,
  mockEval,
  mockAcquireRedisWorkerLock,
  mockLockRelease,
  mockLoggerWarn,
  mockLoggerError,
  mockProcessAiChatOutboxPayload,
  mockGet,
  mockSendOpsAlert,
  mockReleaseGlobalAgentSlot,
  mockReleasePerUserMeteredSlotByRequestId,
} = vi.hoisted(() => ({
  mockLindex: vi.fn(),
  mockRpoplpush: vi.fn(),
  mockLrem: vi.fn(),
  mockScan: vi.fn(),
  mockLrange: vi.fn(),
  mockEval: vi.fn(),
  mockAcquireRedisWorkerLock: vi.fn(),
  mockLockRelease: vi.fn(async () => undefined),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
  mockProcessAiChatOutboxPayload: vi.fn(async () => undefined),
  mockGet: vi.fn(async () => null as string | null),
  mockSendOpsAlert: vi.fn(async () => undefined),
  mockReleaseGlobalAgentSlot: vi.fn(async () => undefined),
  mockReleasePerUserMeteredSlotByRequestId: vi.fn(async () => undefined),
}));

vi.mock('../../src/infrastructure/redis.js', () => ({
  // 锁逻辑已移入共享 helper acquireRedisWorkerLock，这里 mock 它以控制「拿到锁 /
  // 被其他实例占用」；getRedis 仅用于队列读写（scan/lrange）与 pop 脚本（eval）。
  getRedis: vi.fn(() => ({
    lindex: mockLindex,
    rpoplpush: mockRpoplpush,
    lrem: mockLrem,
    scan: mockScan,
    lrange: mockLrange,
    eval: mockEval,
    get: mockGet, // runtime 心跳读取
  })),
  acquireRedisWorkerLock: mockAcquireRedisWorkerLock,
}));

vi.mock('../../src/infrastructure/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: mockLoggerError,
  },
}));

vi.mock('../../src/runtime/ipc-ai-chat-outbox-handler.js', () => ({
  processAiChatOutboxPayload: mockProcessAiChatOutboxPayload,
}));

vi.mock('../../src/infrastructure/alerts.js', () => ({
  sendOpsAlert: mockSendOpsAlert,
}));

vi.mock('../../src/runtime/ipc-worker.js', () => ({
  releaseGlobalAgentSlot: mockReleaseGlobalAgentSlot,
  releasePerUserMeteredSlotByRequestId:
    mockReleasePerUserMeteredSlotByRequestId,
}));

import { runInboxStallSweepOnce } from '../../src/runtime/inbox-stall-sweeper.js';
import { INBOX_STALL_FAIL_MS } from '../../src/shared/timeout-chain.js';

function buildPayload(overrides: Record<string, unknown> = {}): string {
  return encodeRuntimeIpc(
    'web:acct-1',
    'ipc:web:acct-1:inbox:member',
    JSON.stringify({
      type: 'chat',
      requestId: 'aichat-1-abc',
      accountId: 'web:acct-1',
      sessionId: 'session-1',
      userMessageId: 'msg-1',
      ownerUserId: 'user-1',
      timestamp: new Date(
        Date.now() - INBOX_STALL_FAIL_MS - 60_000,
      ).toISOString(),
      ...overrides,
    }),
  );
}

// pop 脚本含 'rpop'，锁释放脚本含 'del'——用脚本内容区分调用目的，
// 不依赖两类 eval 调用之间的先后顺序，测试更不容易因为实现细节调整而碎。
function mockEvalByScriptContent(popResult: number) {
  mockEval.mockImplementation(async (script: unknown) => {
    if (typeof script === 'string' && script.includes('rpop')) {
      return popResult;
    }
    return 1;
  });
}

// 用有状态队列模拟 Redis List：lrange -1 -1 读队尾，pop 脚本（含 rpop）弹出队尾。
// sweepQueue 现在对同一队列循环清理，固定返回值的 mock 无法收敛（队尾永远有值会
// 一直循环到上限）；清理类测试改用它，让队列被弹空后自然停止。
function useStatefulQueue(rawItems: string[]): void {
  const queue = [...rawItems];
  mockLrange.mockImplementation(async () =>
    queue.length > 0 ? [queue[queue.length - 1]] : [],
  );
  mockEval.mockImplementation(async (script: unknown) => {
    if (typeof script === 'string' && script.includes('rpop')) {
      queue.pop();
      return 1;
    }
    return 1; // 锁释放脚本
  });
}

describe('runInboxStallSweepOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLockRelease.mockResolvedValue(undefined);
    mockAcquireRedisWorkerLock.mockResolvedValue({ release: mockLockRelease });
    mockEvalByScriptContent(1);
    // scan 按 MATCH 模式区分：inbox 巡检返回队列 key，outbox 巡检默认无 key。
    mockScan.mockImplementation(
      async (_cursor: string, _m: string, match: string) => [
        '0',
        match.includes('ai-chat:outbox') ? [] : ['ipc:web:acct-1:inbox:member'],
      ],
    );
    mockGet.mockResolvedValue(null);
  });

  it('堆积超过清理阈值的 AI Chat 消息会被弹出并标记为超时失败', async () => {
    useStatefulQueue([buildPayload()]);

    await runInboxStallSweepOnce();

    expect(mockProcessAiChatOutboxPayload).toHaveBeenCalledTimes(1);
    const [payload, fallbackAccountId] = mockProcessAiChatOutboxPayload.mock
      .calls[0] as [Record<string, unknown>, string];
    expect(payload.status).toBe('error');
    expect(payload.requestId).toBe('aichat-1-abc');
    expect(payload.sessionId).toBe('session-1');
    expect(payload.accountId).toBe('web:acct-1');
    expect(fallbackAccountId).toBe('web:acct-1');
    expect(typeof payload.text).toBe('string');
    expect((payload.text as string).length).toBeGreaterThan(0);
    expect(payload.publicReasonCode).toBe('inbox_stall_timeout');
  });

  it('同一队列内多条超龄消息会在一轮内被连续清理', async () => {
    // 消费者掉线时单队列可能堆积多条；循环清理应一轮清空，而非每轮只处理一条。
    useStatefulQueue([buildPayload(), buildPayload(), buildPayload()]);

    await runInboxStallSweepOnce();

    expect(mockProcessAiChatOutboxPayload).toHaveBeenCalledTimes(3);
  });

  it('堆积时长在告警阈值和清理阈值之间时只记日志，不清理', async () => {
    mockLrange.mockResolvedValue([
      buildPayload({
        timestamp: new Date(Date.now() - 6 * 60_000).toISOString(),
      }),
    ]);

    await runInboxStallSweepOnce();

    expect(mockLoggerWarn).toHaveBeenCalled();
    expect(mockProcessAiChatOutboxPayload).not.toHaveBeenCalled();
  });

  it('堆积时长不足告警阈值时完全不处理', async () => {
    mockLrange.mockResolvedValue([
      buildPayload({
        timestamp: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);

    await runInboxStallSweepOnce();

    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(mockProcessAiChatOutboxPayload).not.toHaveBeenCalled();
  });

  it('非站内 AI Chat 形状（微信/task）的陈旧消息不会被自动清理', async () => {
    mockLrange.mockResolvedValue([
      buildPayload({ requestId: 'inbox-1-xyz', sessionId: undefined }),
    ]);

    await runInboxStallSweepOnce();

    expect(mockProcessAiChatOutboxPayload).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it('弹出时队尾已变化（消费者恰好复活取走）则不重复处理', async () => {
    mockLrange.mockResolvedValue([buildPayload()]);
    mockEvalByScriptContent(0);

    await runInboxStallSweepOnce();

    expect(mockProcessAiChatOutboxPayload).not.toHaveBeenCalled();
  });

  it('其他实例持有巡检锁时跳过本轮，不触碰任何队列', async () => {
    mockAcquireRedisWorkerLock.mockResolvedValue(null);
    mockLrange.mockResolvedValue([buildPayload()]);

    await runInboxStallSweepOnce();

    expect(mockScan).not.toHaveBeenCalled();
    expect(mockProcessAiChatOutboxPayload).not.toHaveBeenCalled();
  });

  it('空队列不做任何处理', async () => {
    mockLrange.mockResolvedValue([]);

    await runInboxStallSweepOnce();

    expect(mockProcessAiChatOutboxPayload).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('单个队列处理异常不影响其余队列继续巡检', async () => {
    mockScan.mockResolvedValue([
      '0',
      ['ipc:web:broken:inbox', 'ipc:web:acct-1:inbox:member'],
    ]);
    // 正常队列用有状态模拟：清理一条后弹空，避免 sweepQueue 循环对固定队尾无限清理。
    const goodQueue = [buildPayload()];
    mockLrange.mockImplementation(async (key: string) => {
      if (key === 'ipc:web:broken:inbox') {
        throw new Error('redis 抖动');
      }
      return goodQueue.length > 0 ? [goodQueue[goodQueue.length - 1]] : [];
    });
    mockEval.mockImplementation(async (script: unknown) => {
      if (typeof script === 'string' && script.includes('rpop')) {
        goodQueue.pop();
        return 1;
      }
      return 1;
    });

    await runInboxStallSweepOnce();

    expect(mockProcessAiChatOutboxPayload).toHaveBeenCalledTimes(1);
  });

  it('inbox 有堆积且心跳缺失时，未到清理阈值也会发运维告警', async () => {
    mockLrange.mockResolvedValue([
      buildPayload({
        timestamp: new Date(Date.now() - 6 * 60_000).toISOString(),
      }),
    ]);
    mockGet.mockResolvedValue(null); // 无心跳

    await runInboxStallSweepOnce();

    expect(mockSendOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agent_heartbeat_missing' }),
    );
    expect(mockProcessAiChatOutboxPayload).not.toHaveBeenCalled();
  });

  it('inbox 有堆积但心跳存活时，不发掉线告警', async () => {
    mockLrange.mockResolvedValue([
      buildPayload({
        timestamp: new Date(Date.now() - 6 * 60_000).toISOString(),
      }),
    ]);
    mockGet.mockResolvedValue(String(Date.now())); // 心跳存活

    await runInboxStallSweepOnce();

    expect(mockSendOpsAlert).not.toHaveBeenCalled();
  });
});

describe('runInboxStallSweepOnce · ai-chat outbox 无主消息代消费', () => {
  const OUTBOX_KEY = 'ipc:web:acct-1:ai-chat:outbox';

  function buildOutboxResponse(
    overrides: Record<string, unknown> = {},
  ): string {
    return encodeRuntimeIpc(
      'web:acct-1',
      OUTBOX_KEY,
      JSON.stringify({
        type: 'response',
        requestId: 'aichat-9-zzz',
        accountId: 'web:acct-1',
        sessionId: 'session-9',
        status: 'success',
        text: '这是生成好的回复',
        // 超过无主阈值（3 分钟）
        timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
        ...overrides,
      }),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockLockRelease.mockResolvedValue(undefined);
    mockAcquireRedisWorkerLock.mockResolvedValue({ release: mockLockRelease });
    mockGet.mockResolvedValue(null);
    // inbox 巡检无 key，outbox 巡检返回目标队列。
    mockScan.mockImplementation(
      async (_cursor: string, _m: string, match: string) => [
        '0',
        match === 'ipc:*:ai-chat:outbox' ? [OUTBOX_KEY] : [],
      ],
    );
  });

  function useStatefulOutboxQueue(
    rawItems: string[],
    pendingItems: string[] = [],
  ) {
    const queue = [...rawItems];
    const processing = [...pendingItems];
    const invalid: string[] = [];
    mockLrange.mockImplementation(async (key: string) => {
      const list = key.endsWith(':processing') ? processing : queue;
      return list.length ? [list[list.length - 1]] : [];
    });
    mockLindex.mockImplementation(async () => processing.at(-1) ?? null);
    mockRpoplpush.mockImplementation(async () => {
      const raw = queue.pop();
      if (raw !== undefined) processing.unshift(raw);
      return raw ?? null;
    });
    mockLrem.mockImplementation(
      async (_key: string, _count: number, raw: string) => {
        const index = processing.indexOf(raw);
        if (index < 0) return 0;
        processing.splice(index, 1);
        return 1;
      },
    );
    mockEval.mockImplementation(
      async (
        _script: string,
        _count: number,
        _source: string,
        _target: string,
        raw: string,
      ) => {
        const index = processing.indexOf(raw);
        if (index < 0) return 0;
        invalid.unshift(raw);
        processing.splice(index, 1);
        return 1;
      },
    );
    return { queue, processing, invalid };
  }

  it('超过无主阈值的最终响应被代消费落库，并释放并发槽位', async () => {
    useStatefulOutboxQueue([buildOutboxResponse()]);

    await runInboxStallSweepOnce();

    expect(mockProcessAiChatOutboxPayload).toHaveBeenCalledTimes(1);
    const [payload, fallbackAccountId] = mockProcessAiChatOutboxPayload.mock
      .calls[0] as [Record<string, unknown>, string];
    expect(payload.type).toBe('response');
    expect(payload.requestId).toBe('aichat-9-zzz');
    // accountId 从队列 key 剥离而来（accountId 自身含冒号也要正确）。
    expect(fallbackAccountId).toBe('web:acct-1');
    expect(mockReleaseGlobalAgentSlot).toHaveBeenCalledWith('aichat-9-zzz');
    expect(mockReleasePerUserMeteredSlotByRequestId).toHaveBeenCalledWith(
      'aichat-9-zzz',
    );
    expect(mockLrem).toHaveBeenCalledTimes(1);
  });

  it('未到无主阈值的新消息不代消费（可能有活跃消费者）', async () => {
    useStatefulOutboxQueue([
      buildOutboxResponse({ timestamp: new Date().toISOString() }),
    ]);

    await runInboxStallSweepOnce();

    expect(mockProcessAiChatOutboxPayload).not.toHaveBeenCalled();
  });

  it('quarantines malformed data and continues delivering valid results', async () => {
    const state = useStatefulOutboxQueue([
      '{oops not json',
      buildOutboxResponse(),
    ]);

    await runInboxStallSweepOnce();

    expect(state.invalid).toEqual(['{oops not json']);
    expect(mockProcessAiChatOutboxPayload).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      { queueKey: OUTBOX_KEY },
      'Invalid AI Chat result quarantined',
    );
  });
  it('retains a failed delivery for a later sweep and only acknowledges after success', async () => {
    const raw = buildOutboxResponse();
    const state = useStatefulOutboxQueue([raw]);
    mockProcessAiChatOutboxPayload.mockRejectedValueOnce(
      new Error('synthetic database outage'),
    );
    await runInboxStallSweepOnce();
    expect(state.processing).toEqual([raw]);
    expect(mockLrem).not.toHaveBeenCalled();
    expect(mockReleaseGlobalAgentSlot).not.toHaveBeenCalled();
    await runInboxStallSweepOnce();
    expect(state.processing).toEqual([]);
    expect(mockProcessAiChatOutboxPayload).toHaveBeenCalledTimes(2);
    expect(mockLrem).toHaveBeenCalledTimes(1);
  });

  it('discovers a processing-only queue after the original queue disappears', async () => {
    const state = useStatefulOutboxQueue(
      [],
      [buildOutboxResponse({ timestamp: new Date().toISOString() })],
    );
    mockScan.mockImplementation(
      async (_cursor: string, _m: string, match: string) => [
        '0',
        match.endsWith(':processing') ? [`${OUTBOX_KEY}:processing`] : [],
      ],
    );
    await runInboxStallSweepOnce();
    expect(mockProcessAiChatOutboxPayload).toHaveBeenCalledTimes(1);
    expect(state.processing).toEqual([]);
  });
});
