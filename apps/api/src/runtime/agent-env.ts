/**
 * 宿主机 → Agent-Runner 环境变量契约与统一构建。
 *
 * 所有注入 agent 进程的 env 都从这里产出。
 * 新增 env 字段只需改这一个文件。
 */

import {
  DATABASE_URL,
  REDIS_URL,
  SKILL_API_BASE,
  TIMEZONE,
} from '../infrastructure/config.js';
import { getUserByAccountId, getUserById } from '../infrastructure/db.js';
import { pickSystemEnv } from '../infrastructure/process-env.js';
import { getUserIdFromWebChatRuntimeId } from '../modules/chat/web-chat-runtime.js';

// ---------------------------------------------------------------------------
// 契约接口
// ---------------------------------------------------------------------------

/**
 * 宿主机注入 agent-runner 的环境变量。
 */
export interface AgentEnv {
  // --- 身份 ---
  FATECLAW_ACCOUNT_ID: string;
  FATECLAW_USER_ID: string;

  // --- 运行时 ---
  TZ: string;
  FATECLAW_TIMEZONE: string;

  // --- 连接 ---
  SKILL_API_BASE: string;
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
 * 构建注入 agent-runner 进程的完整 env。
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

    // 连接
    SKILL_API_BASE,
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
