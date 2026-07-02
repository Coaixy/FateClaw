/**
 * 本地模式 agent-runtime 管理。
 *
 * 用 spawn 直接运行 agent-runtime daemon 进程，跳过 Docker。
 * 环境变量通过 agent-env.ts 统一构建，只传递契约内的字段。
 */
import { type ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { createInterface } from 'readline';

import { agentEnvToRecord, buildAgentEnv } from './agent-env.js';
import { logger } from '../infrastructure/logger.js';
import { resolveProjectRoot } from '../infrastructure/project-root.js';
import {
  DEFAULT_LOCAL_AGENT_IDLE_TTL_MS,
  DEFAULT_LOCAL_AGENT_MAX_PROCESSES,
  getLocalAgentRuntimePolicy,
} from '../modules/system/system-config.js';

const LOCAL_AGENT_POLICY_CACHE_MS = 2_000;
const LOCAL_AGENT_FORCE_KILL_DELAY_MS = 10_000;
/**
 * 子进程 stdout 就绪信号：daemon.ts 连上 Redis、具备处理请求能力后会打印这行。
 * spawn() 不报错只代表进程被创建成功，不代表它已经能干活——等这个信号才算数。
 */
const LOCAL_AGENT_READY_SENTINEL = '__FATECLAW_AGENT_READY__';
/** 等待就绪信号的超时上限；超时视为启动失败，主动杀掉半死不活的子进程。 */
const LOCAL_AGENT_READY_TIMEOUT_MS = 20_000;

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
  stopping: boolean;
}

const localAgentProcesses = new Map<string, LocalAgentRecord>();
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
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.();
}

function stopLocalAgentRecord(
  record: LocalAgentRecord,
  reason: 'manual' | 'shutdown' | 'idle_ttl' | 'capacity_limit',
): void {
  const current = localAgentProcesses.get(record.accountId);
  if (current === record) {
    // 立即从容量账本删除，避免正在优雅退出的进程继续阻塞新 runtime。
    localAgentProcesses.delete(record.accountId);
  }
  clearIdleTimer(record);
  record.stopping = true;

  if (record.child.exitCode !== null || record.child.signalCode !== null) {
    clearForceKillTimer(record);
    return;
  }

  if (!record.child.killed) {
    record.child.kill('SIGTERM');
  }
  clearForceKillTimer(record);
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
  }, LOCAL_AGENT_FORCE_KILL_DELAY_MS);
  unrefTimer(record.forceKillTimer);

  logger.info(
    { accountId: record.accountId, pid: record.child.pid, reason },
    '正在停止本地 agent 进程',
  );
}

function scheduleIdleStop(record: LocalAgentRecord, idleTtlMs: number): void {
  if (record.busyCount > 0 || record.stopping) return;
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

async function ensureLocalAgentCapacityForNewStart(
  accountId: string,
): Promise<LocalAgentRuntimePolicy> {
  const policy = await resolveLocalAgentPolicy();
  const countOtherStartingAgents = () =>
    [...startingAgents.keys()].filter((id) => id !== accountId).length;
  let projectedCount =
    localAgentProcesses.size + countOtherStartingAgents() + 1;

  while (projectedCount > policy.maxProcesses) {
    const candidate = findOldestIdleLocalAgent();
    if (!candidate) {
      throw new Error(
        `本地 agent-runtime 常驻进程已达到上限 ${policy.maxProcesses}，且现有 runtime 都在忙，请稍后重试`,
      );
    }
    logger.warn(
      {
        accountId,
        reclaimedAccountId: candidate.accountId,
        maxProcesses: policy.maxProcesses,
        projectedCount,
      },
      '本地 agent 进程达到上限，回收最久未使用的空闲 runtime',
    );
    stopLocalAgentRecord(candidate, 'capacity_limit');
    projectedCount = localAgentProcesses.size + countOtherStartingAgents() + 1;
  }

  return policy;
}

export async function ensureLocalAgentRunning(
  accountId: string,
): Promise<void> {
  const existing = localAgentProcesses.get(accountId);
  if (existing && isChildAlive(existing.child) && !existing.stopping) {
    existing.lastUsedAt = Date.now();
    logger.debug({ accountId }, '本地 agent 已在运行');
    return;
  }
  if (existing) {
    clearRecordTimers(existing);
    localAgentProcesses.delete(accountId);
  }

  const inFlight = startingAgents.get(accountId);
  if (inFlight) {
    return inFlight;
  }

  const startPromise = (async () => {
    await ensureLocalAgentCapacityForNewStart(accountId);
    await doSpawnLocalAgent(accountId);
  })().finally(() => {
    startingAgents.delete(accountId);
  });
  startingAgents.set(accountId, startPromise);
  return startPromise;
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
  const readyTimeoutTimer = setTimeout(() => {
    settleReady?.(
      new Error(`本地 agent 进程 ${LOCAL_AGENT_READY_TIMEOUT_MS}ms 内未上报就绪`),
    );
    settleReady = null;
  }, LOCAL_AGENT_READY_TIMEOUT_MS);

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
    // 分两个 buffer：trace 事件走 debug 级别（生产不刷屏），其他 stderr
    // （真正的错误、依赖告警、未捕获异常等）维持 warn 级别，避免被掩盖。
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
    stopping: false,
  };

  child.on('exit', (code, signal) => {
    clearTimeout(readyTimeoutTimer);
    settleReady?.(new Error('本地 agent 进程在就绪前已退出'));
    settleReady = null;
    clearRecordTimers(record);
    if (localAgentProcesses.get(accountId) === record) {
      localAgentProcesses.delete(accountId);
    }
    logger.warn({ accountId, code, signal }, '本地 agent 进程已退出');
    // 通知上层：该账号名下若有仍在等待响应的在途请求，进程已经没有机会再回复了，
    // 应立即标记失败，而不是让请求方干等到粗粒度超时。
    onProcessExitHandler?.(accountId, { reason: 'exit', code, signal });
  });

  child.on('error', (err) => {
    clearTimeout(readyTimeoutTimer);
    settleReady?.(new Error('本地 agent 进程 error 事件'));
    settleReady = null;
    clearRecordTimers(record);
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
    child.kill();
    throw err;
  }

  localAgentProcesses.set(accountId, record);
  scheduleIdleStop(record, policy.idleTtlMs);
  logger.info({ accountId, pid: child.pid }, '本地 agent 进程已就绪');
}

/**
 * 持有指定本地 agent-runtime 的请求租约。
 *
 * @param accountId runtime 对应的账号或 web runtime ID。
 * @returns 成功持有时返回 accountId，runtime 不存在时返回 undefined。
 */
export function retainLocalAgent(accountId: string): string | undefined {
  const record = localAgentProcesses.get(accountId);
  if (!record || record.stopping || !isChildAlive(record.child)) {
    return undefined;
  }
  clearIdleTimer(record);
  record.busyCount += 1;
  record.lastUsedAt = Date.now();
  return accountId;
}

/**
 * 释放指定本地 agent-runtime 的请求租约，并在空闲后安排回收。
 *
 * @param accountId retainLocalAgent 返回的租约 ID；为空时直接忽略。
 */
export async function releaseLocalAgent(accountId?: string): Promise<void> {
  if (!accountId) return;
  const record = localAgentProcesses.get(accountId);
  if (!record || record.stopping) return;
  record.busyCount = Math.max(0, record.busyCount - 1);
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

export function stopAllLocalAgents(): void {
  for (const record of [...localAgentProcesses.values()]) {
    stopLocalAgentRecord(record, 'shutdown');
  }
  logger.info('所有本地 agent 进程已停止');
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
  startingAgents.clear();
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
