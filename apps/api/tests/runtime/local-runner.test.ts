import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const READY_SENTINEL = '__FATECLAW_AGENT_READY__';

const {
  mockBuildAgentEnv,
  mockExistsSync,
  mockGetLocalAgentRuntimePolicy,
  mockSpawn,
  mockGetHeartbeat,
  spawnedChildren,
  createChild,
} = vi.hoisted(() => {
  const spawned: Array<{
    child: {
      pid: number;
      killed: boolean;
      exitCode: number | null;
      signalCode: string | null;
      stdout: InstanceType<typeof PassThrough>;
      stderr: InstanceType<typeof PassThrough>;
      kill: ReturnType<typeof vi.fn>;
      on: (event: string, listener: (...args: unknown[]) => void) => unknown;
      once: (event: string, listener: (...args: unknown[]) => void) => unknown;
      emit: (event: string, ...args: unknown[]) => boolean;
    };
    command: string;
    args: string[];
    options: unknown;
  }> = [];
  let nextPid = 10_000;

  // 不在这里自动发就绪信号：由 mockSpawn 的默认实现统一处理，方便个别测试
  // 用 mockImplementationOnce 覆盖出"不就绪"的子进程。
  function createChild() {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const child = {
      pid: nextPid,
      killed: false,
      exitCode: null as number | null,
      signalCode: null as string | null,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn((signal?: string) => {
        child.killed = true;
        if (signal === 'SIGKILL') {
          child.signalCode = 'SIGKILL';
        }
        return true;
      }),
      on: (event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return child;
      },
      once: (event: string, listener: (...args: unknown[]) => void) => {
        // 测试里 exit 只触发一次，直接委托给 on 即可。
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return child;
      },
      emit: (event: string, ...args: unknown[]) => {
        for (const listener of listeners.get(event) ?? []) {
          listener(...args);
        }
        return listeners.has(event);
      },
    };
    nextPid += 1;
    return child;
  }

  const mockSpawn = vi.fn(
    (command: string, args: string[], options: unknown) => {
      const child = createChild();
      spawned.push({ child, command, args, options });
      // 默认：子进程"立刻"上报就绪，模拟绝大多数正常启动场景，
      // 现有测试用例不需要为此额外改动。个别测试需要"未就绪"路径时，
      // 用 mockSpawn.mockImplementationOnce(...) 单独覆盖这一次，不写入信号。
      child.stdout.write(`${READY_SENTINEL}\n`);
      return child;
    },
  );

  return {
    mockBuildAgentEnv: vi.fn(async (accountId: string) => ({
      FATECLAW_ACCOUNT_ID: accountId,
      FATECLAW_USER_ID: 'user-1',
      FATECLAW_LOCAL_AGENT_RUNTIME: '1',
      FATECLAW_AGENT_PARENT_PID: '123',
      FATECLAW_PROJECT_ROOT: '/project',
      TZ: 'Asia/Shanghai',
      FATECLAW_TIMEZONE: 'Asia/Shanghai',
    })),
    mockExistsSync: vi.fn(() => true),
    mockGetLocalAgentRuntimePolicy: vi.fn(async () => ({
      maxProcesses: 4,
      idleTtlMs: 30_000,
    })),
    mockSpawn,
    mockGetHeartbeat: vi.fn(async () => 'alive' as string | null),
    spawnedChildren: spawned,
    createChild,
  };
});

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('fs', () => ({
  default: {
    existsSync: mockExistsSync,
    readFileSync: vi.fn(() => ''),
    readdirSync: vi.fn(() => []),
  },
}));

vi.mock('../../src/infrastructure/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../src/infrastructure/alerts.js', () => ({
  sendOpsAlert: vi.fn(async () => undefined),
}));

vi.mock('../../src/infrastructure/redis.js', () => ({
  getRedis: () => ({ get: mockGetHeartbeat }),
}));

vi.mock('../../src/infrastructure/project-root.js', () => ({
  resolveProjectRoot: vi.fn(() => '/project'),
}));

vi.mock('../../src/modules/system/system-config.js', () => ({
  DEFAULT_LOCAL_AGENT_IDLE_TTL_MS: 600_000,
  DEFAULT_LOCAL_AGENT_MAX_PROCESSES: 4,
  getLocalAgentRuntimePolicy: mockGetLocalAgentRuntimePolicy,
}));

vi.mock('../../src/runtime/agent-env.js', () => ({
  agentEnvToRecord: (env: Record<string, string>) => env,
  buildAgentEnv: mockBuildAgentEnv,
}));

import {
  __getLocalAgentStateForTests,
  __resetLocalRunnerForTests,
  __shouldCleanupLocalAgentProcessForTests,
  ensureLocalAgentRunning,
  releaseLocalAgent,
  retainLocalAgent,
  stopAllLocalAgents,
  stopLocalAgent,
} from '../../src/runtime/local-runner.js';
import { logger } from '../../src/infrastructure/logger.js';

describe('local-runner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'));
    __resetLocalRunnerForTests();
    spawnedChildren.length = 0;
    mockSpawn.mockClear();
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
    vi.mocked(logger.debug).mockClear();
    mockGetHeartbeat.mockReset();
    mockGetHeartbeat.mockResolvedValue('alive');
    mockBuildAgentEnv.mockClear();
    mockExistsSync.mockReturnValue(true);
    mockGetLocalAgentRuntimePolicy.mockReset();
    mockGetLocalAgentRuntimePolicy.mockResolvedValue({
      maxProcesses: 4,
      idleTtlMs: 30_000,
    });
    process.env.LOCAL_AGENT_ENTRY_MODE = 'dist';
    delete process.env.LOCAL_AGENT_NODE_MAX_OLD_SPACE_MB;
  });

  afterEach(() => {
    __resetLocalRunnerForTests();
    vi.useRealTimers();
    delete process.env.LOCAL_AGENT_ENTRY_MODE;
    delete process.env.LOCAL_AGENT_NODE_MAX_OLD_SPACE_MB;
  });

  it('reuses the same account runtime without duplicate spawn', async () => {
    await ensureLocalAgentRunning('account-1');
    await ensureLocalAgentRunning('account-1');

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(__getLocalAgentStateForTests()).toEqual([
      expect.objectContaining({
        accountId: 'account-1',
        busyCount: 0,
        hasIdleTimer: true,
      }),
    ]);
  });

  it('forwards warning and error traces as separate structured logs while retaining legacy stderr', async () => {
    await ensureLocalAgentRunning('account-1');
    const stderr = spawnedChildren[0].child.stderr;
    const warning = {
      type: 'model_pool_attempt_completed',
      level: 'warn',
      requestId: 'synthetic-request',
      nodeId: 'a',
      statusCode: 401,
      message: '模型调用失败',
      error: { message: 'invalid api key [已脱敏]' },
    };
    const failure = {
      type: 'model_pool_exhausted',
      level: 'error',
      requestId: 'synthetic-request',
      message: '模型池没有可用节点',
    };
    stderr.write(
      `[trace:warn] ${JSON.stringify(warning)}\n[trace:error] ${JSON.stringify(failure)}\n`,
    );
    stderr.write('[trace:debug] {"type":"model_pool_attempt_started"}\n');
    stderr.write('[agent-runtime] legacy stderr\n[trace:error] invalid JSON\n');
    await vi.advanceTimersByTimeAsync(50);

    const { level: warningLevel, ...warningFields } = warning;
    const { level: failureLevel, ...failureFields } = failure;
    expect(logger.warn).toHaveBeenCalledWith(
      {
        ...warningFields,
        traceLevel: warningLevel,
        accountId: 'account-1',
        source: 'local-agent-trace',
      },
      '[agent-runtime] 模型调用失败',
    );
    expect(logger.error).toHaveBeenCalledWith(
      {
        ...failureFields,
        traceLevel: failureLevel,
        accountId: 'account-1',
        source: 'local-agent-trace',
      },
      '[agent-runtime] 模型池没有可用节点',
    );
    expect(logger.debug).toHaveBeenCalledWith(
      {
        accountId: 'account-1',
        source: 'local-agent-trace',
      },
      '[trace:debug] {"type":"model_pool_attempt_started"}',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      {
        accountId: 'account-1',
        source: 'local-agent-stderr',
      },
      '[agent-runtime] legacy stderr\n[trace:error] invalid JSON',
    );
  });

  it('does not stop a busy runtime when the previous idle timer would fire', async () => {
    await ensureLocalAgentRunning('account-1');
    const lease = retainLocalAgent('account-1');

    await vi.advanceTimersByTimeAsync(30_000);

    expect(lease).toEqual(expect.any(String));
    expect(spawnedChildren[0].child.kill).not.toHaveBeenCalled();
    expect(__getLocalAgentStateForTests()[0]).toEqual(
      expect.objectContaining({ busyCount: 1 }),
    );
  });

  it('stops an idle runtime after lease release and idle ttl', async () => {
    await ensureLocalAgentRunning('account-1');
    const lease = retainLocalAgent('account-1');
    await releaseLocalAgent(lease);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(spawnedChildren[0].child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(spawnedChildren[0].child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(__getLocalAgentStateForTests()).toEqual([]);
  });

  it('reclaims an unresponsive busy child before allowing the same account to restart', async () => {
    mockGetLocalAgentRuntimePolicy.mockResolvedValue({
      maxProcesses: 4,
      idleTtlMs: 86_400_000,
    });
    mockGetHeartbeat.mockResolvedValue(null);
    await ensureLocalAgentRunning('blocked');
    const staleLease = retainLocalAgent('blocked');
    const child = spawnedChildren[0].child;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(mockGetHeartbeat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(__getLocalAgentStateForTests()).toEqual([]);

    const replacement = ensureLocalAgentRunning('blocked');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    child.emit('exit', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(100);
    await replacement;
    const currentLease = retainLocalAgent('blocked');
    await releaseLocalAgent(staleLease);
    expect(__getLocalAgentStateForTests()[0]).toMatchObject({ busyCount: 1 });
    await releaseLocalAgent(currentLease);
    expect(__getLocalAgentStateForTests()[0]).toMatchObject({ busyCount: 0 });
  });

  it('requires consecutive successful missing-heartbeat reads and resets after recovery or Redis failure', async () => {
    mockGetLocalAgentRuntimePolicy.mockResolvedValue({
      maxProcesses: 4,
      idleTtlMs: 86_400_000,
    });
    mockGetHeartbeat
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('alive')
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('Redis unavailable'))
      .mockResolvedValue(null);
    await ensureLocalAgentRunning('healthy');
    retainLocalAgent('healthy');
    const child = spawnedChildren[0].child;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('ignores a heartbeat response for a child that exited while Redis was responding', async () => {
    mockGetLocalAgentRuntimePolicy.mockResolvedValue({
      maxProcesses: 4,
      idleTtlMs: 86_400_000,
    });
    let respond!: (value: string | null) => void;
    mockGetHeartbeat.mockResolvedValueOnce(null).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    await ensureLocalAgentRunning('replaced');
    retainLocalAgent('replaced');
    await vi.advanceTimersByTimeAsync(40_000);
    stopLocalAgent('replaced');
    spawnedChildren[0].child.exitCode = 0;
    spawnedChildren[0].child.emit('exit', 0, null);
    await ensureLocalAgentRunning('replaced');
    retainLocalAgent('replaced');
    respond(null);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spawnedChildren[1].child.kill).not.toHaveBeenCalled();
    expect(__getLocalAgentStateForTests()[0]).toMatchObject({ busyCount: 1 });
  });

  it('releases each process lease only once', async () => {
    await ensureLocalAgentRunning('account-1');
    const first = retainLocalAgent('account-1');
    const second = retainLocalAgent('account-1');
    await releaseLocalAgent(first);
    await releaseLocalAgent(first);
    expect(__getLocalAgentStateForTests()[0]).toMatchObject({
      busyCount: 1,
      hasIdleTimer: false,
    });
    await releaseLocalAgent(second);
    expect(__getLocalAgentStateForTests()[0]).toMatchObject({
      busyCount: 0,
      hasIdleTimer: true,
    });
  });

  it('reclaims the oldest idle runtime before spawning over maxProcesses', async () => {
    mockGetLocalAgentRuntimePolicy.mockResolvedValue({
      maxProcesses: 2,
      idleTtlMs: 86_400_000,
    });

    await ensureLocalAgentRunning('account-old');
    vi.setSystemTime(new Date('2026-06-05T00:00:01.000Z'));
    await ensureLocalAgentRunning('account-newer');
    vi.setSystemTime(new Date('2026-06-05T00:00:02.000Z'));
    const third = ensureLocalAgentRunning('account-third');
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    spawnedChildren[0].child.exitCode = 0;
    spawnedChildren[0].child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(100);
    await third;

    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(spawnedChildren[0].child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(
      __getLocalAgentStateForTests().map((item) => item.accountId),
    ).toEqual(['account-newer', 'account-third']);
  });

  it('rejects a new runtime when maxProcesses is reached and all runtimes are busy', async () => {
    mockGetLocalAgentRuntimePolicy.mockResolvedValue({
      maxProcesses: 1,
      idleTtlMs: 86_400_000,
    });
    await ensureLocalAgentRunning('account-1');
    retainLocalAgent('account-1');

    const pending = ensureLocalAgentRunning('account-2', {
      deadlineAtMs: Date.now() + 500,
    });
    const rejected = expect(pending).rejects.toThrow(
      '等待本地 agent-runtime 容量超时',
    );
    await vi.advanceTimersByTimeAsync(500);
    await rejected;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(
      __getLocalAgentStateForTests().map((item) => item.accountId),
    ).toEqual(['account-1']);
  });

  it('waits for busy capacity to release and for the reclaimed process to exit', async () => {
    mockGetLocalAgentRuntimePolicy.mockResolvedValue({
      maxProcesses: 1,
      idleTtlMs: 86_400_000,
    });
    await ensureLocalAgentRunning('busy');
    const lease = retainLocalAgent('busy');
    const next = ensureLocalAgentRunning('waiting');
    await vi.advanceTimersByTimeAsync(100);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    await releaseLocalAgent(lease);
    await vi.advanceTimersByTimeAsync(100);
    expect(spawnedChildren[0].child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    spawnedChildren[0].child.exitCode = 0;
    spawnedChildren[0].child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(100);
    await next;
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('uses the admitted request deadline when busy capacity lasts longer than thirty seconds', async () => {
    mockGetLocalAgentRuntimePolicy.mockResolvedValue({
      maxProcesses: 1,
      idleTtlMs: 86_400_000,
    });
    await ensureLocalAgentRunning('busy');
    const lease = retainLocalAgent('busy');
    const next = ensureLocalAgentRunning('waiting', {
      deadlineAtMs: Date.now() + 90_000,
    });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    await releaseLocalAgent(lease);
    await vi.advanceTimersByTimeAsync(100);
    spawnedChildren[0].child.exitCode = 0;
    spawnedChildren[0].child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(100);
    await next;
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('cancels a capacity waiter without reserving or starting a process', async () => {
    mockGetLocalAgentRuntimePolicy.mockResolvedValue({
      maxProcesses: 1,
      idleTtlMs: 86_400_000,
    });
    await ensureLocalAgentRunning('busy');
    retainLocalAgent('busy');
    let cancelled = false;
    const next = ensureLocalAgentRunning('cancelled', {
      isCancelled: () => cancelled,
    });
    const rejection = expect(next).rejects.toThrow('请求已取消或超时');
    await vi.advanceTimersByTimeAsync(1_000);
    cancelled = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('admits simultaneous distinct accounts without counting waiters as starts', async () => {
    mockGetLocalAgentRuntimePolicy.mockResolvedValue({
      maxProcesses: 2,
      idleTtlMs: 86_400_000,
    });
    await Promise.all([
      ensureLocalAgentRunning('one'),
      ensureLocalAgentRunning('two'),
    ]);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(__getLocalAgentStateForTests()).toHaveLength(2);
  });

  it('shares an in-flight start while cancelling only the requesting waiter', async () => {
    mockSpawn.mockImplementationOnce(
      (command: string, args: string[], options: unknown) => {
        const child = createChild();
        spawnedChildren.push({ child, command, args, options });
        return child;
      },
    );
    let cancelled = false;
    const one = ensureLocalAgentRunning('shared', {
      isCancelled: () => cancelled,
    });
    const rejection = expect(one).rejects.toThrow('请求已取消或超时');
    const two = ensureLocalAgentRunning('shared');
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    cancelled = true;
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    spawnedChildren[0].child.stdout.write(`${READY_SENTINEL}\n`);
    await two;
    expect(__getLocalAgentStateForTests()).toHaveLength(1);
  });

  it('removes records and timers when child exits', async () => {
    await ensureLocalAgentRunning('account-1');

    spawnedChildren[0].child.exitCode = 0;
    spawnedChildren[0].child.emit('exit', 0, null);

    expect(__getLocalAgentStateForTests()).toEqual([]);
  });

  describe('readiness handshake', () => {
    it('does not register the runtime until stdout reports the ready sentinel', async () => {
      // 默认实现是"立刻"写入就绪信号，这里手动接管这一次 spawn，验证在收到
      // 信号之前 ensureLocalAgentRunning 确实还在等待、不会提前记录runtime。
      mockSpawn.mockImplementationOnce(
        (command: string, args: string[], options: unknown) => {
          const child = createChild();
          spawnedChildren.push({ child, command, args, options });
          return child;
        },
      );

      const pending = ensureLocalAgentRunning('account-slow-ready');
      // 让 ensureLocalAgentCapacityForNewStart 等前置 await 都走完，真正跑到 spawn()。
      await vi.advanceTimersByTimeAsync(0);
      expect(__getLocalAgentStateForTests()).toEqual([]);

      spawnedChildren[0].child.stdout.write(`${READY_SENTINEL}\n`);
      await pending;

      expect(__getLocalAgentStateForTests()).toEqual([
        expect.objectContaining({ accountId: 'account-slow-ready' }),
      ]);
    });

    it('rejects when the child exits before reporting ready', async () => {
      mockSpawn.mockImplementationOnce(
        (command: string, args: string[], options: unknown) => {
          const child = createChild();
          spawnedChildren.push({ child, command, args, options });
          return child; // 不写入就绪信号
        },
      );

      const pending = ensureLocalAgentRunning('account-crash-before-ready');
      await vi.advanceTimersByTimeAsync(0);
      spawnedChildren[0].child.emit('exit', 1, null);

      await expect(pending).rejects.toThrow('本地 agent 进程在就绪前已退出');
      expect(__getLocalAgentStateForTests()).toEqual([]);
    });

    it('rejects and kills the child when the ready sentinel never arrives', async () => {
      mockSpawn.mockImplementationOnce(
        (command: string, args: string[], options: unknown) => {
          const child = createChild();
          spawnedChildren.push({ child, command, args, options });
          return child; // 不写入就绪信号
        },
      );

      const pending = ensureLocalAgentRunning('account-timeout');
      // 断言拒绝的同时推进计时器，避免 unhandledRejection 先于断言触发。
      const assertion = expect(pending).rejects.toThrow(
        '本地 agent 进程 20000ms 内未上报就绪',
      );
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;

      expect(spawnedChildren[0].child.kill).toHaveBeenCalled();
      expect(__getLocalAgentStateForTests()).toEqual([]);
    });
  });

  it('passes LOCAL_AGENT_NODE_MAX_OLD_SPACE_MB to dist node args', async () => {
    process.env.LOCAL_AGENT_NODE_MAX_OLD_SPACE_MB = '128';

    await ensureLocalAgentRunning('account-1');

    expect(spawnedChildren[0].command).toBe('node');
    expect(spawnedChildren[0].args).toEqual([
      '--max-old-space-size=128',
      '/project/apps/agent-runtime/dist/daemon.js',
    ]);
  });

  it('matches orphan cleanup only for FateClaw-marked runtime under the same project root', () => {
    const root = '/project';
    const baseEnv = {
      FATECLAW_LOCAL_AGENT_RUNTIME: '1',
      FATECLAW_PROJECT_ROOT: root,
      FATECLAW_AGENT_PARENT_PID: '123',
    };

    expect(
      __shouldCleanupLocalAgentProcessForTests(baseEnv, root, new Set([123])),
    ).toBe(false);
    expect(
      __shouldCleanupLocalAgentProcessForTests(baseEnv, root, new Set()),
    ).toBe(true);
    expect(
      __shouldCleanupLocalAgentProcessForTests(
        { ...baseEnv, FATECLAW_LOCAL_AGENT_RUNTIME: '0' },
        root,
        new Set(),
      ),
    ).toBe(false);
    expect(
      __shouldCleanupLocalAgentProcessForTests(
        { ...baseEnv, FATECLAW_PROJECT_ROOT: '/other' },
        root,
        new Set(),
      ),
    ).toBe(false);
  });
});

describe('stopAllLocalAgents（停机时序）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetLocalRunnerForTests();
    spawnedChildren.length = 0;
    mockSpawn.mockClear();
    mockExistsSync.mockReturnValue(true);
    mockGetLocalAgentRuntimePolicy.mockResolvedValue({
      maxProcesses: 4,
      idleTtlMs: 30_000,
    });
    process.env.LOCAL_AGENT_ENTRY_MODE = 'dist';
  });

  afterEach(() => {
    __resetLocalRunnerForTests();
    vi.useRealTimers();
    delete process.env.LOCAL_AGENT_ENTRY_MODE;
  });

  it('对所有子进程发 SIGTERM，并等它们真正退出后才 resolve', async () => {
    await ensureLocalAgentRunning('account-a');
    await ensureLocalAgentRunning('account-b');

    let resolved = false;
    const stopPromise = stopAllLocalAgents().then(() => {
      resolved = true;
    });

    expect(spawnedChildren[0].child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(spawnedChildren[1].child.kill).toHaveBeenCalledWith('SIGTERM');
    // 子进程尚未退出：不应提前 resolve（历史缺陷是同步返回导致 drain 被掐断）。
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    for (const spawned of spawnedChildren) {
      spawned.child.exitCode = 0;
      spawned.child.emit('exit', 0, null);
    }
    await stopPromise;
    expect(resolved).toBe(true);
  });

  it('waits for an already retiring child and force-kills it after the shutdown drain window', async () => {
    await ensureLocalAgentRunning('account-a');
    stopLocalAgent('account-a');

    let resolved = false;
    const stopPromise = stopAllLocalAgents().then(() => {
      resolved = true;
    });

    // 30 秒内（daemon drain 窗口）绝不能 SIGKILL。
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resolved).toBe(false);
    expect(spawnedChildren[0].child.kill).not.toHaveBeenCalledWith('SIGKILL');

    // 到 36 秒：强杀定时器（35s）触发 + 等待上限（36s）到期。
    await vi.advanceTimersByTimeAsync(6_000);
    expect(spawnedChildren[0].child.kill).toHaveBeenCalledWith('SIGKILL');
    await stopPromise;
  });
});
