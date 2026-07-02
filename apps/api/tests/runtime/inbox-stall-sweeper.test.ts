import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockScan,
  mockLrange,
  mockEval,
  mockSet,
  mockLoggerWarn,
  mockLoggerError,
  mockProcessAiChatOutboxPayload,
} = vi.hoisted(() => ({
  mockScan: vi.fn(),
  mockLrange: vi.fn(),
  mockEval: vi.fn(),
  mockSet: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
  mockProcessAiChatOutboxPayload: vi.fn(async () => undefined),
}));

vi.mock('../../src/infrastructure/redis.js', () => ({
  getRedis: vi.fn(() => ({
    scan: mockScan,
    lrange: mockLrange,
    eval: mockEval,
    set: mockSet,
  })),
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

import { runInboxStallSweepOnce } from '../../src/runtime/inbox-stall-sweeper.js';

function buildPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'chat',
    requestId: 'aichat-1-abc',
    accountId: 'web:acct-1',
    sessionId: 'session-1',
    userMessageId: 'msg-1',
    ownerUserId: 'user-1',
    timestamp: new Date(Date.now() - 11 * 60_000).toISOString(),
    ...overrides,
  });
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

describe('runInboxStallSweepOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSet.mockResolvedValue('OK');
    mockEvalByScriptContent(1);
    mockScan.mockResolvedValue(['0', ['ipc:web:acct-1:inbox:member']]);
  });

  it('堆积超过清理阈值的 AI Chat 消息会被弹出并标记为超时失败', async () => {
    mockLrange.mockResolvedValue([buildPayload()]);

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
    mockSet.mockResolvedValue(null);
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
    mockLrange.mockImplementation(async (key: string) => {
      if (key === 'ipc:web:broken:inbox') {
        throw new Error('redis 抖动');
      }
      return [buildPayload()];
    });

    await runInboxStallSweepOnce();

    expect(mockProcessAiChatOutboxPayload).toHaveBeenCalledTimes(1);
  });
});
