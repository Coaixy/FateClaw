/**
 * 本地模式 agent-runner 管理。
 *
 * 用 spawn 直接运行 agent-runner daemon 进程，跳过 Docker。
 * 环境变量通过 agent-env.ts 统一构建，只传递契约内的字段。
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { createInterface } from 'readline';

import { agentEnvToRecord, buildAgentEnv } from './agent-env.js';
import { logger } from '../infrastructure/logger.js';
import { resolveProjectRoot } from '../infrastructure/project-root.js';

const localAgentProcesses = new Map<string, ChildProcess>();

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

  throw new Error(`agent-runner 入口不存在: ${distEntry} 或 ${srcEntry}`);
}

// 同 accountId 的并发启动 promise 共享，防止多个调用各自 spawn 出孤儿进程
const startingAgents = new Map<string, Promise<void>>();

export async function ensureLocalAgentRunning(
  accountId: string,
): Promise<void> {
  const existing = localAgentProcesses.get(accountId);
  if (existing && !existing.killed && existing.exitCode === null) {
    logger.debug({ accountId }, '本地 agent 已在运行');
    return;
  }

  const inFlight = startingAgents.get(accountId);
  if (inFlight) {
    return inFlight;
  }

  const startPromise = doSpawnLocalAgent(accountId).finally(() => {
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

async function doSpawnLocalAgent(accountId: string): Promise<void> {
  // 本地开发默认优先源码，生产/显式指定时再使用 dist，避免源码与运行物漂移
  const projectRoot = resolveProjectRoot();
  const agentRunnerBase = path.join(projectRoot, 'packages', 'agent-runner');
  const { daemonEntry, mode } = resolveLocalAgentEntry({ agentRunnerBase });

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
  const [command, commandArgs] =
    mode === 'dist'
      ? (['node', [daemonEntry]] as [string, string[]])
      : ([devAgent.command, [...devAgent.args, daemonEntry]] as [
          string,
          string[],
        ]);

  const child = spawn(command, commandArgs, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: projectRoot,
  });

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

  child.on('exit', (code, signal) => {
    localAgentProcesses.delete(accountId);
    logger.warn({ accountId, code, signal }, '本地 agent 进程已退出');
  });

  child.on('error', (err) => {
    localAgentProcesses.delete(accountId);
    logger.error({ accountId, err }, '本地 agent 进程出错');
  });

  localAgentProcesses.set(accountId, child);
  logger.info({ accountId, pid: child.pid }, '本地 agent 进程已启动');
}

export function stopLocalAgent(accountId: string): void {
  const child = localAgentProcesses.get(accountId);
  if (child && !child.killed) {
    child.kill('SIGTERM');
    localAgentProcesses.delete(accountId);
    logger.info({ accountId }, '本地 agent 进程已停止');
  }
}

export function stopAllLocalAgents(): void {
  for (const [accountId, child] of localAgentProcesses) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
    localAgentProcesses.delete(accountId);
  }
  logger.info('所有本地 agent 进程已停止');
}
