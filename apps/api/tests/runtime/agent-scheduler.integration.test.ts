import Redis from 'ioredis';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const { holder, ready, retain } = vi.hoisted(() => ({
  holder: { redis: undefined as unknown },
  ready: vi.fn(async (_accountId: string) => {}),
  retain: vi.fn((accountId: string) => `lease:${accountId}`),
}));
vi.mock('../../src/infrastructure/redis.js', () => ({
  getRedis: () => holder.redis,
}));
vi.mock('../../src/modules/system/system-config.js', () => ({
  getAgentConcurrencyLimit: async () => 2,
}));
vi.mock('../../src/infrastructure/logger.js', () => ({
  logger: { warn: vi.fn() },
}));
vi.mock('../../src/runtime/local-runner.js', () => ({
  ensureLocalAgentRunning: ready,
  retainLocalAgent: retain,
  releaseLocalAgent: vi.fn(async () => {}),
}));
import {
  acquireAgentExecution,
  releaseGlobalAgentSlot,
  resetAgentScheduler,
} from '../../src/runtime/agent-scheduler.js';

const url = process.env.FATECLAW_TEST_SCHEDULER_REDIS_URL;
describe.skipIf(!url)('execution scheduling with real Redis', () => {
  let redis: Redis;
  const tasks = new Map<string, Promise<string>>();
  const cancelled = new Set<string>();
  beforeAll(() => {
    redis = new Redis(url!, { maxRetriesPerRequest: 1 });
    holder.redis = redis;
  });
  beforeEach(async () => {
    // This opt-in URL must identify a disposable Redis database.
    await redis.flushdb();
    ready.mockReset().mockResolvedValue(undefined);
    retain.mockClear();
    cancelled.clear();
    resetAgentScheduler();
  });
  afterEach(async () => {
    for (const id of tasks.keys()) cancelled.add(id);
    for (const id of tasks.keys()) await releaseGlobalAgentSlot(id);
    await Promise.allSettled(tasks.values());
    tasks.clear();
    await redis.flushdb();
  });
  afterAll(async () => {
    await redis.quit();
  });
  function submit(
    requestId: string,
    accountId: string,
    priority: 'normal' | 'member' = 'normal',
  ) {
    const task = acquireAgentExecution({
      requestId,
      accountId,
      priority,
      deadlineAtMs: Date.now() + 30_000,
      shouldContinue: () => !cancelled.has(requestId),
      onRuntimeReady: () => true,
    });
    tasks.set(requestId, task);
    void task.catch(() => {});
    return task;
  }

  it('keeps startup and same-account waiting outside global execution capacity', async () => {
    let finishStartup!: () => void;
    ready.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStartup = resolve;
        }),
    );
    const first = submit('first', 'account-a');
    await vi.waitFor(() => expect(finishStartup).toBeTypeOf('function'));
    expect(await redis.zcard('agent:concurrency:active')).toBe(0);
    await submit('other', 'account-b');
    const second = submit('second', 'account-a');
    await vi.waitFor(async () =>
      expect(await redis.zcard('agent:runtime:wait:account-a')).toBe(1),
    );
    expect(ready).toHaveBeenCalledTimes(2);
    expect(await redis.zcard('agent:concurrency:active')).toBe(1);
    finishStartup();
    await first;
    const releasedAt = Date.now();
    await releaseGlobalAgentSlot('first');
    await second;
    expect(Date.now() - releasedAt).toBeLessThan(1_000);
    expect(await redis.get('agent:runtime:active:account-a')).toMatch(
      /^second:/,
    );
    await releaseGlobalAgentSlot('first');
    expect(await redis.get('agent:runtime:active:account-a')).toMatch(
      /^second:/,
    );
  });

  it('preserves member priority among runnable accounts under global saturation', async () => {
    await submit('first', 'account-a');
    await submit('second', 'account-b');
    const normal = submit('normal', 'account-c');
    await vi.waitFor(async () =>
      expect(await redis.zcard('agent:concurrency:waitq:normal')).toBe(1),
    );
    const member = submit('member', 'account-d', 'member');
    await vi.waitFor(async () =>
      expect(await redis.zcard('agent:concurrency:waitq:member')).toBe(1),
    );
    await releaseGlobalAgentSlot('first');
    await member;
    expect(await redis.zscore('agent:concurrency:active', 'normal')).toBeNull();
    await releaseGlobalAgentSlot('second');
    await normal;
  });

  it('does not release replacement capacity when an earlier admission resumes cleanup', async () => {
    await submit('recoverable', 'account-a');
    const oldToken = await redis.hget(
      'agent:runtime:owner:recoverable',
      'token',
    );
    await releaseGlobalAgentSlot('recoverable');
    await submit('recoverable', 'account-a');
    await releaseGlobalAgentSlot('recoverable', oldToken!);
    expect(
      await redis.zscore('agent:concurrency:active', 'recoverable'),
    ).not.toBeNull();
    expect(
      await redis.hget('agent:runtime:owner:recoverable', 'token'),
    ).not.toBe(oldToken);
  });

  it('cancels an account waiter without starting a runtime or leaking its queue entry', async () => {
    await submit('first', 'account-a');
    const waiting = submit('cancelled', 'account-a');
    await vi.waitFor(async () =>
      expect(await redis.zcard('agent:runtime:wait:account-a')).toBe(1),
    );
    cancelled.add('cancelled');
    await releaseGlobalAgentSlot('cancelled');
    await expect(waiting).rejects.toThrow('请求已取消或超时');
    expect(ready).toHaveBeenCalledTimes(1);
    expect(await redis.zcard('agent:runtime:wait:account-a')).toBe(0);
    expect(await redis.get('agent:runtime:active:account-a')).toMatch(
      /^first:/,
    );
  });

  it('evicts dead account waiters and releases ownership on runtime startup failure', async () => {
    await redis.zadd('agent:runtime:wait:account-a', 0, 'dead');
    ready.mockRejectedValueOnce(new Error('synthetic startup failure'));
    await expect(submit('failed', 'account-a')).rejects.toThrow(
      'synthetic startup failure',
    );
    expect(await redis.get('agent:runtime:active:account-a')).toBeNull();
    expect(await redis.zcard('agent:concurrency:active')).toBe(0);
    await expect(submit('replacement', 'account-a')).resolves.toBe(
      'replacement',
    );
  });
});
