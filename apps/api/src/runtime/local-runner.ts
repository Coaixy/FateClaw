import { capacityChanged } from './capacity-signal.js';
/**
 * 本地模式 agent-runtime 管理。
 *
 * 用 spawn 直接运行 agent-runtime daemon 进程，跳过 Docker。
 * 环境变量通过 agent-env.ts 统一构建，只传递契约内的字段。
 */
import { type ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'node:crypto';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { createInterface } from 'readline';

import { agentEnvToRecord, buildAgentEnv } from './agent-env.js';
import { sendOpsAlert } from '../infrastructure/alerts.js';
import { logger } from '../infrastructure/logger.js';
import { getRedis } from '../infrastructure/redis.js';
import { resolveProjectRoot } from '../infrastructure/project-root.js';
import {
  DEFAULT_LOCAL_AGENT_IDLE_TTL_MS,
  DEFAULT_LOCAL_AGENT_MAX_PROCESSES,
  getLocalAgentRuntimePolicy,
} from '../modules/system/system-config.js';

const LOCAL_AGENT_POLICY_CACHE_MS = 2_000;
const LOCAL_AGENT_FORCE_KILL_DELAY_MS = 10_000;
const LOCAL_AGENT_HEARTBEAT_STARTUP_GRACE_MS = 30_000;
const LOCAL_AGENT_HEARTBEAT_CHECK_MS = 10_000;
const LOCAL_AGENT_HEARTBEAT_MISS_LIMIT = 2;
/**
 * 宿主整体停机（shutdown）场景的强杀延迟：必须大于 daemon 的优雅 drain 上限
 * （apps/agent-runtime/src/daemon.ts 的 SHUTDOWN_DRAIN_MS = 30s），否则子进程
 * 正在排空的 in-flight 请求会被提前 SIGKILL、响应丢失。
 */
const LOCAL_AGENT_SHUTDOWN_FORCE_KILL_DELAY_MS = 35_000;
/** stopAllLocalAgents 等待全部子进程退出的上限（略大于 shutdown 强杀延迟）。 */
const LOCAL_AGENT_SHUTDOWN_WAIT_MS = 36_000;
/**
 * 子进程 stdout 就绪信号：daemon.ts 连上 Redis、具备处理请求能力后会打印这行。
 * spawn() 不报错只代表进程被创建成功，不代表它已经能干活——等这个信号才算数。
 */
const LOCAL_AGENT_READY_SENTINEL = '__FATECLAW_AGENT_READY__';
/**
 * 等待就绪信号的超时上限；超时视为启动失败，主动杀掉半死不活的子进程。
 * 按入口模式区分：dist（预编译）只需 node 加载 + 连 Redis，20 秒足够；dev（tsx
 * 源码）首次冷启动要现场编译整张 import 图，叠加 Redis 慢/重连时 20 秒可能不够、
 * 会误杀马上就绪的进程并反复重启，故放宽到 60 秒。
 */
const LOCAL_AGENT_READY_TIMEOUT_DIST_MS = 20_000;
const LOCAL_AGENT_READY_TIMEOUT_DEV_MS = 60_000;

interface LocalAgentRuntimePolicy {
  maxProcesses: number;
  idleTtlMs: number;
}

interface LocalAgentRecord {
  accountId: string;
  child: ChildProcess;
  busyCount: number;
  lastUsedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  forceKillTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  heartbeatMisses: number;
  stopping: boolean;
}

const localAgentProcesses = new Map<string, LocalAgentRecord>();
const initializingAgents = new Map<string, LocalAgentRecord>();
const retiringAgents = new Set<LocalAgentRecord>();
const localAgentLeases = new Map<string, LocalAgentRecord>();
let shuttingDown = false;
let cachedLocalAgentPolicy: {
  value: LocalAgentRuntimePolicy;
  expiresAtMs: number;
} | null = null;

/** 本地 agent-runtime 子进程异常退出时的详情，供上层生成失败响应文案/日志。 */
export interface LocalAgentProcessExitInfo {
  reason: 'exit' | 'error';
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

type LocalAgentProcessExitHandler = (
  accountId: string,
  info: LocalAgentProcessExitInfo,
) => void;

let onProcessExitHandler: LocalAgentProcessExitHandler | undefined;

/**
 * 注册"本地 agent-runtime 子进程异常退出"的通知回调。
 *
 * local-runner.ts 只负责管理子进程生命周期，不认识"某账号有哪些请求正在等待响应"
 * 这件事（那是 ipc-worker.ts 的职责）。ipc-worker.ts 已经反过来 import 了本模块，
 * 若本模块再直接 import ipc-worker.ts 会形成循环依赖；因此改为由 ipc-worker.ts
 * 在启动时注册这个回调，子进程退出/出错时在这里回调通知，而不是直接互相引用。
 *
 * @param handler 子进程 exit/error 时调用的回调；重复注册会覆盖前一个。
 */
export function onLocalAgentProcessExit(
  handler: LocalAgentProcessExitHandler,
): void {
  onProcessExitHandler = handler;
}

type LocalAgentEntryMode = 'auto' | 'src' | 'dist';

function resolveLocalAgentEntry(args: { agentRunnerBase: string }): {
  daemonEntry: string;
  mode: 'dist' | 'dev';
} {
  const distEntry = path.join(args.agentRunnerBase, 'dist', 'daemon.js');
  const srcEntry = path.join(args.agentRunnerBase, 'src', 'daemon.ts');
  const hasDist = fs.existsSync(distEntry);
  const hasSrc = fs.existsSync(srcEntry);

  const configuredMode = (
    process.env.LOCAL_AGENT_ENTRY_MODE || 'auto'
  ).toLowerCase() as LocalAgentEntryMode;
  const isProduction = process.env.NODE_ENV === 'production';

  if (configuredMode === 'dist') {
    if (!hasDist) {
      throw new Error(`LOCAL_AGENT_ENTRY_MODE=dist 但入口不存在: ${distEntry}`);
    }
    return { daemonEntry: distEntry, mode: 'dist' };
  }

  if (configuredMode === 'src') {
    if (!hasSrc) {
      throw new Error(`LOCAL_AGENT_ENTRY_MODE=src 但入口不存在: ${srcEntry}`);
    }
    return { daemonEntry: srcEntry, mode: 'dev' };
  }

  // auto:
  // - 本地开发默认优先源码，避免 dist 陈旧导致“改了源码却没生效”
  // - 生产环境优先 dist，兼容只部署编译产物的场景
  if (!isProduction && hasSrc) {
    return { daemonEntry: srcEntry, mode: 'dev' };
  }
  if (hasDist) {
    return { daemonEntry: distEntry, mode: 'dist' };
  }
  if (hasSrc) {
    return { daemonEntry: srcEntry, mode: 'dev' };
  }

  throw new Error(`agent-runtime 入口不存在: ${distEntry} 或 ${srcEntry}`);
}

// 同 accountId 的并发启动 promise 共享，防止多个调用各自 spawn 出孤儿进程
const startingAgents = new Map<string, Promise<void>>();

function isChildAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null && !child.killed;
}

function normalizeLocalAgentPolicy(
  value: Partial<LocalAgentRuntimePolicy> | null | undefined,
): LocalAgentRuntimePolicy {
  return {
    maxProcesses: Math.min(
      100,
      Math.max(
        1,
        Math.floor(value?.maxProcesses ?? DEFAULT_LOCAL_AGENT_MAX_PROCESSES),
      ),
    ),
    idleTtlMs: Math.min(
      86_400_000,
      Math.max(
        30_000,
        Math.floor(value?.idleTtlMs ?? DEFAULT_LOCAL_AGENT_IDLE_TTL_MS),
      ),
    ),
  };
}

async function resolveLocalAgentPolicy(): Promise<LocalAgentRuntimePolicy> {
  if (
    cachedLocalAgentPolicy &&
    cachedLocalAgentPolicy.expiresAtMs > Date.now()
  ) {
    return cachedLocalAgentPolicy.value;
  }

  try {
    const value = normalizeLocalAgentPolicy(await getLocalAgentRuntimePolicy());
    cachedLocalAgentPolicy = {
      value,
      expiresAtMs: Date.now() + LOCAL_AGENT_POLICY_CACHE_MS,
    };
    return value;
  } catch (err) {
    const fallback = normalizeLocalAgentPolicy(null);
    cachedLocalAgentPolicy = {
      value: fallback,
      expiresAtMs: Date.now() + LOCAL_AGENT_POLICY_CACHE_MS,
    };
    logger.warn({ err, fallback }, '读取本地 agent 运行时策略失败，使用默认值');
    return fallback;
  }
}

function clearIdleTimer(record: LocalAgentRecord): void {
  if (record.idleTimer) {
    clearTimeout(record.idleTimer);
    record.idleTimer = null;
  }
}

function clearForceKillTimer(record: LocalAgentRecord): void {
  if (record.forceKillTimer) {
    clearTimeout(record.forceKillTimer);
    record.forceKillTimer = null;
  }
}

function clearRecordTimers(record: LocalAgentRecord): void {
  clearIdleTimer(record);
  clearForceKillTimer(record);
  if (record.heartbeatTimer) clearTimeout(record.heartbeatTimer);
  record.heartbeatTimer = null;
}

function discardRecordLeases(record: LocalAgentRecord): void {
  for (const [leaseId, owner] of localAgentLeases) {
    if (owner === record) localAgentLeases.delete(leaseId);
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.();
}

function stopLocalAgentRecord(
  record: LocalAgentRecord,
  reason:
    | 'manual'
    | 'shutdown'
    | 'idle_ttl'
    | 'capacity_limit'
    | 'heartbeat_missing',
): void {
  const current = localAgentProcesses.get(record.accountId);
  if (current === record) {
    // Remove from reuse while retaining its capacity until the child exits.
    localAgentProcesses.delete(record.accountId);
  }
  clearIdleTimer(record);
  if (record.heartbeatTimer) clearTimeout(record.heartbeatTimer);
  record.heartbeatTimer = null;
  discardRecordLeases(record);
  record.stopping = true;
  retiringAgents.add(record);

  if (
    record.child.pid === undefined ||
    record.child.exitCode !== null ||
    record.child.signalCode !== null
  ) {
    clearForceKillTimer(record);
    retiringAgents.delete(record);
    capacityChanged.notify();
    return;
  }

  if (!record.child.killed) {
    record.child.kill('SIGTERM');
  }
  clearForceKillTimer(record);
  // Only host shutdown needs the full drain window; an unresponsive daemon cannot drain.
  const forceKillDelayMs =
    reason === 'shutdown'
      ? LOCAL_AGENT_SHUTDOWN_FORCE_KILL_DELAY_MS
      : LOCAL_AGENT_FORCE_KILL_DELAY_MS;
  record.forceKillTimer = setTimeout(() => {
    if (record.child.exitCode !== null || record.child.signalCode !== null) {
      return;
    }
    try {
      record.child.kill('SIGKILL');
      logger.warn(
        { accountId: record.accountId, pid: record.child.pid, reason },
        '本地 agent 进程 SIGTERM 后未退出，已强制终止',
      );
    } catch (err) {
      logger.warn(
        { accountId: record.accountId, pid: record.child.pid, err, reason },
        '强制终止本地 agent 进程失败',
      );
    }
  }, forceKillDelayMs);
  unrefTimer(record.forceKillTimer);

  logger.info(
    { accountId: record.accountId, pid: record.child.pid, reason },
    '正在停止本地 agent 进程',
  );
}

function scheduleIdleStop(record: LocalAgentRecord, idleTtlMs: number): void {
  if (
    localAgentProcesses.get(record.accountId) !== record ||
    record.busyCount > 0 ||
    record.stopping
  )
    return;
  clearIdleTimer(record);
  record.idleTimer = setTimeout(() => {
    const current = localAgentProcesses.get(record.accountId);
    if (current !== record || record.busyCount > 0 || record.stopping) {
      return;
    }
    logger.info(
      {
        accountId: record.accountId,
        pid: record.child.pid,
        idleTtlMs,
      },
      '本地 agent 空闲超时，准备回收',
    );
    stopLocalAgentRecord(record, 'idle_ttl');
  }, idleTtlMs);
  unrefTimer(record.idleTimer);
}

function findOldestIdleLocalAgent(): LocalAgentRecord | undefined {
  return [...localAgentProcesses.values()]
    .filter((record) => record.busyCount === 0 && !record.stopping)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
}

function scheduleHeartbeatCheck(
  record: LocalAgentRecord,
  delayMs = LOCAL_AGENT_HEARTBEAT_CHECK_MS,
): void {
  record.heartbeatTimer = setTimeout(async () => {
    record.heartbeatTimer = null;
    if (localAgentProcesses.get(record.accountId) !== record || record.stopping)
      return;
    try {
      const heartbeat = await getRedis().get(
        `agent:heartbeat:${record.accountId}`,
      );
      // The child can exit or be replaced while Redis is responding.
      if (
        localAgentProcesses.get(record.accountId) !== record ||
        record.stopping
      )
        return;
      record.heartbeatMisses =
        heartbeat === null ? record.heartbeatMisses + 1 : 0;
      if (record.heartbeatMisses >= LOCAL_AGENT_HEARTBEAT_MISS_LIMIT) {
        stopLocalAgentRecord(record, 'heartbeat_missing');
        void sendOpsAlert({
          kind: 'agent_heartbeat_missing',
          title: 'agent-runtime 心跳持续缺失，正在回收进程',
          detail: `accountId=${record.accountId}，pid=${record.child.pid}`,
          context: { accountId: record.accountId, pid: record.child.pid },
        });
        return;
      }
    } catch (err) {
      // Redis failure is unknown liveness, not evidence that the child is blocked.
      record.heartbeatMisses = 0;
      logger.warn(
        { accountId: record.accountId, err },
        '本地 agent 心跳检查失败',
      );
    }
    if (
      localAgentProcesses.get(record.accountId) === record &&
      !record.stopping
    ) {
      scheduleHeartbeatCheck(record);
    }
  }, delayMs);
  unrefTimer(record.heartbeatTimer);
}

export interface LocalAgentAdmissionOptions {
  deadlineAtMs?: number;
  isCancelled?: () => boolean;
}

function checkAdmission(
  options: LocalAgentAdmissionOptions,
  deadlineAtMs: number,
): void {
  if (shuttingDown) throw new Error('Local agent runtime is shutting down');
  if (options.isCancelled?.()) throw new Error('请求已取消或超时');
  if (Date.now() >= deadlineAtMs)
    throw new Error('等待本地 agent-runtime 容量超时，请稍后重试');
}

async function waitForStartup(
  start: Promise<void>,
  options: LocalAgentAdmissionOptions,
): Promise<void> {
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    await Promise.race([
      start,
      new Promise<never>((_resolve, reject) => {
        timer = setInterval(() => {
          try {
            checkAdmission(options, options.deadlineAtMs ?? Infinity);
          } catch (err) {
            reject(err);
          }
        }, 100);
      }),
    ]);
    checkAdmission(options, options.deadlineAtMs ?? Infinity);
  } finally {
    clearInterval(timer);
  }
}

export async function ensureLocalAgentRunning(
  accountId: string,
  options: LocalAgentAdmissionOptions = {},
): Promise<void> {
  const capacityDeadline = options.deadlineAtMs ?? Date.now() + 30_000;
  while (true) {
    const revision = capacityChanged.revision;
    checkAdmission(options, capacityDeadline);
    const policy = await resolveLocalAgentPolicy();
    checkAdmission(options, capacityDeadline);
    // No awaits between the capacity check and registering the new startup.
    // Waiters consume no reservation, so simultaneous arrivals cannot deadlock.
    const existing = localAgentProcesses.get(accountId);
    if (existing && isChildAlive(existing.child) && !existing.stopping) {
      existing.lastUsedAt = Date.now();
      return;
    }
    if (existing) {
      clearRecordTimers(existing);
      localAgentProcesses.delete(accountId);
    }
    const inFlight = startingAgents.get(accountId);
    if (inFlight) return waitForStartup(inFlight, options);
    const accounts = new Set([
      ...localAgentProcesses.keys(),
      ...startingAgents.keys(),
    ]);
    // A replacement must not consume the inbox until its predecessor has exited.
    const retiringSameAccount = [...retiringAgents].some(
      (record) => record.accountId === accountId,
    );
    if (
      !retiringSameAccount &&
      accounts.size + retiringAgents.size < policy.maxProcesses
    ) {
      const start = doSpawnLocalAgent(accountId).finally(() =>
        startingAgents.delete(accountId),
      );
      startingAgents.set(accountId, start);
      return waitForStartup(start, options);
    }
    const idle = findOldestIdleLocalAgent();
    if (!retiringSameAccount && idle && retiringAgents.size === 0)
      stopLocalAgentRecord(idle, 'capacity_limit');
    await capacityChanged.wait(
      Math.min(1_000, Math.max(1, capacityDeadline - Date.now())),
      revision,
    );
  }
}

/**
 * 解析 tsx CLI 入口，返回 { command, args } 以绕过 Windows 上 spawn npx 找不到
 * npx.cmd 导致 ENOENT 的问题。
 *
 * 优先用 createRequire 解析 tsx 模块路径（pnpm 兼容），直接用 node 执行 tsx CLI；
 * 解析失败时回退到平台感知的 npx（Windows: npx.cmd）。
 */
function resolveDevAgentCommand(projectRoot: string): {
  command: string;
  args: string[];
} {
  try {
    const projectRequire = createRequire(
      path.join(projectRoot, 'package.json'),
    );
    const tsxPkgPath = projectRequire.resolve('tsx/package.json');
    const tsxPkg = JSON.parse(fs.readFileSync(tsxPkgPath, 'utf-8'));
    const bin = typeof tsxPkg.bin === 'string' ? tsxPkg.bin : tsxPkg.bin?.tsx;
    if (bin) {
      return {
        command: process.execPath,
        args: [path.join(path.dirname(tsxPkgPath), bin)],
      };
    }
  } catch {
    // tsx 未在 node_modules 中，回退到 npx
  }

  return process.platform === 'win32'
    ? { command: 'npx.cmd', args: ['tsx'] }
    : { command: 'npx', args: ['tsx'] };
}

function resolveLocalAgentNodeMemoryArgs(): string[] {
  const maxOldSpaceMb = Number.parseInt(
    process.env.LOCAL_AGENT_NODE_MAX_OLD_SPACE_MB || '',
    10,
  );
  if (!Number.isFinite(maxOldSpaceMb) || maxOldSpaceMb <= 0) {
    return [];
  }
  return [`--max-old-space-size=${Math.floor(maxOldSpaceMb)}`];
}

async function doSpawnLocalAgent(accountId: string): Promise<void> {
  // 本地开发默认优先源码，生产/显式指定时再使用 dist，避免源码与运行物漂移
  const projectRoot = resolveProjectRoot();
  const agentRunnerBase = path.join(projectRoot, 'apps', 'agent-runtime');
  const { daemonEntry, mode } = resolveLocalAgentEntry({ agentRunnerBase });
  const policy = await resolveLocalAgentPolicy();

  const agentEnv = await buildAgentEnv(accountId);
  const env = agentEnvToRecord(agentEnv);

  logger.info(
    {
      accountId,
      entry: daemonEntry,
      mode,
      envKeys: Object.keys(env),
      hasAccountId: 'FATECLAW_ACCOUNT_ID' in env,
      accountIdValue: env.FATECLAW_ACCOUNT_ID?.slice(0, 8) + '…',
    },
    '启动本地 agent 进程',
  );

  const devAgent = resolveDevAgentCommand(projectRoot);
  const nodeMemoryArgs = resolveLocalAgentNodeMemoryArgs();
  const [command, commandArgs] = (() => {
    if (mode === 'dist') {
      return ['node', [...nodeMemoryArgs, daemonEntry]] as [string, string[]];
    }
    if (devAgent.command === process.execPath) {
      return [
        devAgent.command,
        [...nodeMemoryArgs, ...devAgent.args, daemonEntry],
      ] as [string, string[]];
    }
    return [devAgent.command, [...devAgent.args, daemonEntry]] as [
      string,
      string[],
    ];
  })();

  if (shuttingDown) throw new Error('Local agent runtime is shutting down');
  const child = spawn(command, commandArgs, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: projectRoot,
  });

  // 就绪等待：spawn() 不报错只说明进程被创建成功，不代表它已经连上 Redis、能开始
  // 处理请求。四个来源之一敲定即生效（只生效一次，靠 settleReady 置空防重复）：
  // stdout 收到就绪信号 → 成功；就绪前 exit/error → 失败；超时都没等到 → 失败。
  let settleReady: ((error?: Error) => void) | null = null;
  const readyPromise = new Promise<void>((resolve, reject) => {
    settleReady = (error) => {
      if (error) reject(error);
      else resolve();
    };
  });
  // dev（tsx 冷启动）比 dist 需要更长就绪时间，按 mode 取对应超时上限，避免误杀。
  const readyTimeoutMs =
    mode === 'dev'
      ? LOCAL_AGENT_READY_TIMEOUT_DEV_MS
      : LOCAL_AGENT_READY_TIMEOUT_DIST_MS;
  const readyTimeoutTimer = setTimeout(() => {
    settleReady?.(
      new Error(`本地 agent 进程 ${readyTimeoutMs}ms 内未上报就绪`),
    );
    settleReady = null;
  }, readyTimeoutMs);

  if (child.stdout) {
    let stdoutBuf: string[] = [];
    let stdoutTimer: ReturnType<typeof setTimeout> | null = null;
    const flushStdout = () => {
      if (stdoutBuf.length > 0) {
        logger.info({ accountId, source: 'local-agent' }, stdoutBuf.join('\n'));
        stdoutBuf = [];
      }
      stdoutTimer = null;
    };
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line) return;
      if (line === LOCAL_AGENT_READY_SENTINEL) {
        clearTimeout(readyTimeoutTimer);
        settleReady?.();
        settleReady = null;
        return; // 控制信号，不计入日志缓冲
      }
      stdoutBuf.push(line);
      if (stdoutTimer) clearTimeout(stdoutTimer);
      stdoutTimer = setTimeout(flushStdout, 50);
    });
    child.on('exit', flushStdout);
  }

  if (child.stderr) {
    // Keep diagnostic failures structured and visible at the default log level.
    // Routine traces and unstructured stderr retain their existing buffers.
    let stderrBuf: string[] = [];
    let traceBuf: string[] = [];
    let stderrTimer: ReturnType<typeof setTimeout> | null = null;
    const flushStderr = () => {
      if (stderrBuf.length > 0) {
        logger.warn(
          { accountId, source: 'local-agent-stderr' },
          stderrBuf.join('\n'),
        );
        stderrBuf = [];
      }
      if (traceBuf.length > 0) {
        logger.debug(
          { accountId, source: 'local-agent-trace' },
          traceBuf.join('\n'),
        );
        traceBuf = [];
      }
      stderrTimer = null;
    };
    const rl = createInterface({ input: child.stderr });
    rl.on('line', (line) => {
      if (!line) return;
      const diagnostic = /^\[trace:(warn|error)\] (.+)$/.exec(line);
      if (diagnostic) {
        try {
          const parsed: unknown = JSON.parse(diagnostic[2]);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const { level: _level, ...entry } = parsed as Record<
              string,
              unknown
            >;
            const level = diagnostic[1] as 'warn' | 'error';
            const message =
              typeof entry.message === 'string' ? entry.message : entry.type;
            logger[level](
              {
                ...entry,
                traceLevel: level,
                accountId,
                source: 'local-agent-trace',
              },
              `[agent-runtime] ${message ?? '运行诊断'}`,
            );
            return;
          }
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      if (line.startsWith('[trace:debug] ')) {
        traceBuf.push(line);
      } else {
        stderrBuf.push(line);
      }
      if (stderrTimer) clearTimeout(stderrTimer);
      stderrTimer = setTimeout(flushStderr, 50);
    });
    child.on('exit', flushStderr);
  }

  const record: LocalAgentRecord = {
    accountId,
    child,
    busyCount: 0,
    lastUsedAt: Date.now(),
    idleTimer: null,
    forceKillTimer: null,
    heartbeatTimer: null,
    heartbeatMisses: 0,
    stopping: false,
  };

  initializingAgents.set(accountId, record);
  child.on('exit', (code, signal) => {
    initializingAgents.delete(accountId);
    retiringAgents.delete(record);
    capacityChanged.notify();
    clearTimeout(readyTimeoutTimer);
    settleReady?.(new Error('本地 agent 进程在就绪前已退出'));
    settleReady = null;
    clearRecordTimers(record);
    discardRecordLeases(record);
    if (localAgentProcesses.get(accountId) === record) {
      localAgentProcesses.delete(accountId);
    }
    logger.warn({ accountId, code, signal }, '本地 agent 进程已退出');
    // 非主动停止且非 0 退出码：大概率是崩溃/OOM，升级为运维告警（按 kind 节流）。
    if (!record.stopping && code !== 0) {
      void sendOpsAlert({
        kind: 'agent_process_exited',
        title: 'agent-runtime 子进程异常退出',
        detail: `accountId=${accountId}，code=${code ?? 'null'}，signal=${signal ?? 'null'}（code=137/SIGKILL 通常是 OOM）`,
        context: { accountId, code, signal },
      });
    }
    // 通知上层：该账号名下若有仍在等待响应的在途请求，进程已经没有机会再回复了，
    // 应立即标记失败，而不是让请求方干等到粗粒度超时。
    onProcessExitHandler?.(accountId, { reason: 'exit', code, signal });
  });

  child.on('error', (err) => {
    initializingAgents.delete(accountId);
    retiringAgents.delete(record);
    capacityChanged.notify();
    clearTimeout(readyTimeoutTimer);
    settleReady?.(new Error('本地 agent 进程 error 事件'));
    settleReady = null;
    clearRecordTimers(record);
    discardRecordLeases(record);
    if (localAgentProcesses.get(accountId) === record) {
      localAgentProcesses.delete(accountId);
    }
    logger.error({ accountId, err }, '本地 agent 进程出错');
    onProcessExitHandler?.(accountId, {
      reason: 'error',
      code: null,
      signal: null,
      error: err,
    });
  });

  try {
    await readyPromise;
  } catch (err) {
    initializingAgents.delete(accountId);
    stopLocalAgentRecord(record, 'manual');
    throw err;
  }

  initializingAgents.delete(accountId);
  if (shuttingDown) {
    stopLocalAgentRecord(record, 'shutdown');
    throw new Error('Local agent runtime is shutting down');
  }
  localAgentProcesses.set(accountId, record);
  scheduleIdleStop(record, policy.idleTtlMs);
  scheduleHeartbeatCheck(record, LOCAL_AGENT_HEARTBEAT_STARTUP_GRACE_MS);
  logger.info({ accountId, pid: child.pid }, '本地 agent 进程已就绪');
}

/**
 * Retain a lease owned by this exact child process. The opaque token prevents
 * late or duplicate cleanup from decrementing a replacement process's busy count.
 */
export function retainLocalAgent(accountId: string): string | undefined {
  const record = localAgentProcesses.get(accountId);
  if (!record || record.stopping || !isChildAlive(record.child)) {
    return undefined;
  }
  clearIdleTimer(record);
  record.busyCount += 1;
  record.lastUsedAt = Date.now();
  const leaseId = randomUUID();
  localAgentLeases.set(leaseId, record);
  return leaseId;
}

/**
 * Release a retained lease once, then schedule idle reclamation for its owner.
 */
export async function releaseLocalAgent(leaseId?: string): Promise<void> {
  if (!leaseId) return;
  const record = localAgentLeases.get(leaseId);
  if (!record) return;
  localAgentLeases.delete(leaseId);
  if (localAgentProcesses.get(record.accountId) !== record || record.stopping)
    return;
  record.busyCount = Math.max(0, record.busyCount - 1);
  capacityChanged.notify();
  record.lastUsedAt = Date.now();
  if (record.busyCount > 0) return;
  const policy = await resolveLocalAgentPolicy();
  scheduleIdleStop(record, policy.idleTtlMs);
}

export function stopLocalAgent(accountId: string): void {
  const record = localAgentProcesses.get(accountId);
  if (record) {
    stopLocalAgentRecord(record, 'manual');
  }
}

/**
 * 停止所有本地 agent-runtime 子进程，并等待它们真正退出。
 *
 * 历史缺陷：此前只发 SIGTERM 就同步返回，宿主 shutdown 随即断开 Redis/DB 并
 * `process.exit(0)`——子进程 30s 的优雅 drain 窗口完全用不满，in-flight 请求
 * 的响应被丢弃。现在返回 Promise：等所有子进程 exit（或到达上限
 * `LOCAL_AGENT_SHUTDOWN_WAIT_MS`）后才 resolve，宿主 shutdown 应 await 它。
 *
 * @returns 所有子进程退出或等待超时后 resolve；超时的进程已由强杀定时器接管。
 */
export async function stopAllLocalAgents(): Promise<void> {
  shuttingDown = true;
  const records = [
    ...new Set([
      ...localAgentProcesses.values(),
      ...initializingAgents.values(),
      ...retiringAgents,
    ]),
  ];
  const exitPromises = records
    // A successful kill() only sends a signal; retiring children can still be running.
    .filter(
      (record) =>
        record.child.exitCode === null && record.child.signalCode === null,
    )
    .map(
      (record) =>
        new Promise<void>((resolve) => {
          record.child.once('exit', () => resolve());
        }),
    );
  for (const record of records) {
    stopLocalAgentRecord(record, 'shutdown');
  }
  if (exitPromises.length > 0) {
    await Promise.race([
      Promise.all(exitPromises),
      new Promise<void>((resolve) => {
        const waitTimer = setTimeout(resolve, LOCAL_AGENT_SHUTDOWN_WAIT_MS);
        unrefTimer(waitTimer);
      }),
    ]);
  }
  logger.info(
    { stopped: records.length },
    '所有本地 agent 进程已停止（或已到等待上限）',
  );
}

function parseProcEnviron(raw: Buffer | string): Record<string, string> {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  const env: Record<string, string> = {};
  for (const entry of text.split('\0')) {
    if (!entry) continue;
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return env;
}

function isLinuxProcessAlive(pid: number): boolean {
  return fs.existsSync(`/proc/${pid}`);
}

function shouldCleanupLocalAgentProcess(args: {
  env: Record<string, string>;
  projectRoot: string;
  isProcessAlive: (pid: number) => boolean;
}): boolean {
  if (args.env.FATECLAW_LOCAL_AGENT_RUNTIME !== '1') return false;
  const envProjectRoot = args.env.FATECLAW_PROJECT_ROOT;
  if (!envProjectRoot || path.resolve(envProjectRoot) !== args.projectRoot) {
    return false;
  }
  const parentPid = Number.parseInt(
    args.env.FATECLAW_AGENT_PARENT_PID || '',
    10,
  );
  if (!Number.isFinite(parentPid) || parentPid <= 0) {
    return true;
  }
  return !args.isProcessAlive(parentPid);
}

function terminateStaleLocalAgentPid(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code !== 'ESRCH') {
      logger.warn({ pid, err }, '清理旧本地 agent 进程时发送 SIGTERM 失败');
    }
    return;
  }

  const forceKillTimer = setTimeout(() => {
    if (!isLinuxProcessAlive(pid)) return;
    try {
      process.kill(pid, 'SIGKILL');
      logger.warn({ pid }, '旧本地 agent 进程 SIGTERM 后未退出，已强制终止');
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code !== 'ESRCH') {
        logger.warn({ pid, err }, '强制清理旧本地 agent 进程失败');
      }
    }
  }, LOCAL_AGENT_FORCE_KILL_DELAY_MS);
  unrefTimer(forceKillTimer);
}

/**
 * API 启动时清理上一任宿主异常退出后留下的本地 agent-runtime。
 *
 * 只在 Linux 上扫描 /proc，且必须同时匹配 FateClaw 标记和当前 projectRoot；
 * 这样不会误杀用户手动启动或同机其他部署的 node 进程。
 */
export function cleanupStaleLocalAgentsOnStartup(): void {
  if (process.platform !== 'linux') return;

  const projectRoot = resolveProjectRoot();
  let scanned = 0;
  let cleaned = 0;
  for (const entry of fs.readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number.parseInt(entry.name, 10);
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) continue;
    scanned += 1;

    let env: Record<string, string>;
    try {
      env = parseProcEnviron(fs.readFileSync(`/proc/${pid}/environ`));
    } catch {
      continue;
    }
    if (
      !shouldCleanupLocalAgentProcess({
        env,
        projectRoot,
        isProcessAlive: isLinuxProcessAlive,
      })
    ) {
      continue;
    }
    cleaned += 1;
    terminateStaleLocalAgentPid(pid);
  }

  if (cleaned > 0) {
    logger.warn({ scanned, cleaned }, '已清理旧本地 agent-runtime 孤儿进程');
  } else {
    logger.debug({ scanned }, '未发现需要清理的旧本地 agent-runtime 进程');
  }
}

/** 单个本地 agent-runtime 子进程的状态快照（供运维状态面板展示）。 */
export interface LocalAgentStatusItem {
  accountId: string;
  /** 在途请求租约数。 */
  busyCount: number;
  /** 最近一次被使用的毫秒时间戳。 */
  lastUsedAt: number;
  pid?: number;
  /** 是否正在停止（已发 SIGTERM 等待退出）。 */
  stopping: boolean;
  /** 子进程当前是否存活。 */
  alive: boolean;
}

/**
 * 读取当前所有本地 agent-runtime 子进程的状态快照。
 *
 * @returns 每个账号一条记录；无副作用，仅用于运维观测。
 */
export function getLocalAgentRuntimeStatus(): LocalAgentStatusItem[] {
  return [...localAgentProcesses.values()].map((record) => ({
    accountId: record.accountId,
    busyCount: record.busyCount,
    lastUsedAt: record.lastUsedAt,
    pid: record.child.pid,
    stopping: record.stopping,
    alive: isChildAlive(record.child),
  }));
}

/**
 * 测试用：读取本模块内部 runtime 状态快照。
 */
export function __getLocalAgentStateForTests(): Array<{
  accountId: string;
  busyCount: number;
  lastUsedAt: number;
  pid?: number;
  stopping: boolean;
  hasIdleTimer: boolean;
}> {
  return [...localAgentProcesses.values()].map((record) => ({
    accountId: record.accountId,
    busyCount: record.busyCount,
    lastUsedAt: record.lastUsedAt,
    pid: record.child.pid,
    stopping: record.stopping,
    hasIdleTimer: Boolean(record.idleTimer),
  }));
}

/**
 * 测试用：重置本模块缓存、timer 和进程账本。
 */
export function __resetLocalRunnerForTests(): void {
  for (const record of localAgentProcesses.values()) {
    clearRecordTimers(record);
  }
  localAgentProcesses.clear();
  for (const record of retiringAgents) clearRecordTimers(record);
  retiringAgents.clear();
  for (const record of initializingAgents.values()) clearRecordTimers(record);
  initializingAgents.clear();
  shuttingDown = false;
  startingAgents.clear();
  localAgentLeases.clear();
  cachedLocalAgentPolicy = null;
}

/**
 * 测试用：判断一组 /proc environ 是否会被孤儿清理逻辑匹配。
 *
 * @param env 进程环境变量快照。
 * @param projectRoot 当前部署根目录。
 * @param aliveParentPids 被视为仍存活的父进程 PID 集合。
 */
export function __shouldCleanupLocalAgentProcessForTests(
  env: Record<string, string>,
  projectRoot: string,
  aliveParentPids: Set<number>,
): boolean {
  return shouldCleanupLocalAgentProcess({
    env,
    projectRoot: path.resolve(projectRoot),
    isProcessAlive: (pid) => aliveParentPids.has(pid),
  });
}
