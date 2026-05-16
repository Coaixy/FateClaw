/**
 * Agent-Runner 运行时上下文。
 *
 * 启动时从 process.env 解析一次，之后所有模块通过 getContext() 访问。
 * 模型运行时不属于进程上下文，必须由每个 IPC 请求携带 llmRuntime。
 */

export interface AgentContext {
  /** 运行时会话键：微信为 bot ID，站内 AI Chat 为 web:{userId}。 */
  accountId: string;
  /** 用户 ID（users.id），用于外部 API 鉴权。 */
  userId: string;
  /** 用户时区。 */
  timezone: string;
  /** Skill API 基础地址。 */
  skillApiBase: string;
}

let _ctx: AgentContext | null = null;

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`缺少环境变量 ${key}`);
  }
  return value;
}

/**
 * 从 process.env 解析运行时上下文。必须在进程启动时调用一次。
 */
export function initContext(): AgentContext {
  _ctx = {
    accountId: requireEnv('HUSHBAY_ACCOUNT_ID'),
    userId: process.env.HUSHBAY_USER_ID?.trim() || '',
    timezone:
      process.env.HUSHBAY_TIMEZONE || process.env.TZ || 'Asia/Shanghai',
    skillApiBase:
      process.env.SKILL_API_BASE || 'https://skill.lookfate.com/api/v1',
  };
  return _ctx;
}

/**
 * 获取已初始化的运行时上下文。未初始化时抛出错误。
 */
export function getContext(): AgentContext {
  if (!_ctx) {
    throw new Error('AgentContext 未初始化，请先调用 initContext()');
  }
  return _ctx;
}
