/**
 * 宿主机 → Agent Runtime 环境变量契约与统一构建。
 *
 * 所有注入 agent 进程的 env 都从这里产出。
 * 新增 env 字段只需改这一个文件。
 */

import { DATABASE_URL, REDIS_URL, TIMEZONE } from '../infrastructure/config.js';
import { getUserByAccountId, getUserById } from '../infrastructure/db.js';
import { pickSystemEnv } from '../infrastructure/process-env.js';
import { getUserIdFromWebChatRuntimeId } from '../modules/chat/web-chat-runtime.js';
import { resolveProjectRoot } from '../infrastructure/project-root.js';

// ---------------------------------------------------------------------------
// 契约接口
// ---------------------------------------------------------------------------

/**
 * 宿主机注入 agent-runtime 的环境变量。
 */
export interface AgentEnv {
  // --- 身份 ---
  FATECLAW_ACCOUNT_ID: string;
  FATECLAW_USER_ID: string;

  // --- 运行时 ---
  TZ: string;
  FATECLAW_TIMEZONE: string;
  /** Pi session 本地文件目录；传给本地 agent-runtime 以保持宿主清理路径一致。 */
  FATECLAW_PI_SESSION_DIR?: string;
  /** 标记本进程是宿主拉起的本地 agent-runtime，供孤儿清理精确识别。 */
  FATECLAW_LOCAL_AGENT_RUNTIME: '1';
  /** 宿主 API 进程 PID，非优雅重启后用于识别孤儿 agent-runtime。 */
  FATECLAW_AGENT_PARENT_PID: string;
  /** 当前部署根目录，避免误清理同机其他 FateClaw 实例。 */
  FATECLAW_PROJECT_ROOT: string;

  // --- 连接 ---
  REDIS_URL?: string;
  DATABASE_URL?: string;

  // --- 系统 ---
  PATH?: string;
  Path?: string;
  HOME?: string;
  USERPROFILE?: string;
  SystemRoot?: string;
  WINDIR?: string;
  TEMP?: string;
  TMP?: string;
  ComSpec?: string;
  NODE_ENV?: string;
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 构建注入 agent-runtime 进程的完整 env。
 */
export async function buildAgentEnv(accountId: string): Promise<AgentEnv> {
  const webUserId = getUserIdFromWebChatRuntimeId(accountId);
  const user = webUserId
    ? await getUserById(webUserId)
    : await getUserByAccountId(accountId);
  const systemEnv = pickSystemEnv();

  const env: AgentEnv = {
    ...systemEnv,
    // 身份
    FATECLAW_ACCOUNT_ID: accountId,
    FATECLAW_USER_ID: user?.id ?? '',

    // 运行时
    TZ: TIMEZONE,
    FATECLAW_TIMEZONE: TIMEZONE,
    FATECLAW_PI_SESSION_DIR: process.env.FATECLAW_PI_SESSION_DIR || undefined,
    FATECLAW_LOCAL_AGENT_RUNTIME: '1',
    FATECLAW_AGENT_PARENT_PID: String(process.pid),
    FATECLAW_PROJECT_ROOT: resolveProjectRoot(),

    // 连接
    REDIS_URL: REDIS_URL || process.env.REDIS_URL || undefined,
    DATABASE_URL: DATABASE_URL || process.env.DATABASE_URL || undefined,

    // 系统
    NODE_ENV: process.env.NODE_ENV,
  };

  return env;
}

/**
 * 将 AgentEnv 转为 Record<string, string>，过滤 undefined 值。
 */
export function agentEnvToRecord(env: AgentEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== null) {
      result[key] = String(value);
    }
  }
  return result;
}
