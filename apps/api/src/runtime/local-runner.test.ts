import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockBuildAgentEnv,
  mockExistsSync,
  mockGetLocalAgentRuntimePolicy,
  mockSpawn,
  spawnedChildren,
} = vi.hoisted(() => {
  const spawned: Array<{
    child: {
      pid: number;
      killed: boolean;
      exitCode: number | null;
      signalCode: string | null;
      stdout: null;
      stderr: null;
      kill: ReturnType<typeof vi.fn>;
      on: (event: string, listener: (...args: unknown[]) => void) => unknown;
      emit: (event: string, ...args: unknown[]) => boolean;
    };
    command: string;
    args: string[];
    options: unknown;
  }> = [];
  let nextPid = 10_000;

  function createChild() {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const child = {
      pid: nextPid,
      killed: false,
      exitCode: null as number | null,
      signalCode: null as string | null,
      stdout: null,
      stderr: null,
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
    mockSpawn: vi.fn((command: string, args: string[], options: unknown) => {
      const child = createChild();
      spawned.push({ child, command, args, options });
      return child;
    }),
    spawnedChildren: spawned,
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

vi.mock('../infrastructure/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../infrastructure/project-root.js', () => ({
  resolveProjectRoot: vi.fn(() => '/project'),
}));

vi.mock('../modules/system/system-config.js', () => ({
  DEFAULT_LOCAL_AGENT_IDLE_TTL_MS: 600_000,
  DEFAULT_LOCAL_AGENT_MAX_PROCESSES: 4,
  getLocalAgentRuntimePolicy: mockGetLocalAgentRuntimePolicy,
}));

vi.mock('./agent-env.js', () => ({
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
} from './local-runner.js';

describe('local-runner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'));
    __resetLocalRunnerForTests();
    spawnedChildren.length = 0;
    mockSpawn.mockClear();
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

  it('does not stop a busy runtime when the previous idle timer would fire', async () => {
    await ensureLocalAgentRunning('account-1');
    const lease = retainLocalAgent('account-1');

    await vi.advanceTimersByTimeAsync(30_000);

    expect(lease).toBe('account-1');
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

  it('reclaims the oldest idle runtime before spawning over maxProcesses', async () => {
    mockGetLocalAgentRuntimePolicy.mockResolvedValue({
      maxProcesses: 2,
      idleTtlMs: 86_400_000,
    });

    await ensureLocalAgentRunning('account-old');
    vi.setSystemTime(new Date('2026-06-05T00:00:01.000Z'));
    await ensureLocalAgentRunning('account-newer');
    vi.setSystemTime(new Date('2026-06-05T00:00:02.000Z'));
    await ensureLocalAgentRunning('account-third');

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

    await expect(ensureLocalAgentRunning('account-2')).rejects.toThrow(
      '本地 agent-runtime 常驻进程已达到上限 1',
    );

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(
      __getLocalAgentStateForTests().map((item) => item.accountId),
    ).toEqual(['account-1']);
  });

  it('removes records and timers when child exits', async () => {
    await ensureLocalAgentRunning('account-1');

    spawnedChildren[0].child.exitCode = 0;
    spawnedChildren[0].child.emit('exit', 0, null);

    expect(__getLocalAgentStateForTests()).toEqual([]);
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
