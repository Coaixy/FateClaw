/**
 * 站内 AI Chat 的运行时会话键。
 *
 * 它不是微信账号，也不会写入 accounts 表；仅用于复用 agent-runtime
 * 现有的 Redis 队列、消息归档和 trace 归档分区能力。
 */

const WEB_CHAT_RUNTIME_PREFIX = 'web:';
// workflow(DAG)运行专用运行时键前缀。它仍以 'web:' 开头,故 isWebChatRuntimeId / owner 反查 /
// outbox 队列路由都把它当普通 web 运行时同等处理;唯一差别是 accountId 不同 → agent-runtime 为它
// 派生【独立的 daemon 进程与 inbox/outbox 队列】,从而让 workflow 的 AI 节点与普通对话物理隔离、
// 不再争抢同一用户唯一的 chat daemon 并发槽(根治"workflow 跑时普通对话卡死无内容"回归)。
const WEB_WORKFLOW_RUNTIME_PREFIX = 'web:wf:';

export function getWebChatRuntimeId(userId: string): string {
  return `${WEB_CHAT_RUNTIME_PREFIX}${userId}`;
}

/**
 * workflow(DAG)运行专用运行时键:`web:wf:{userId}`。
 *
 * @remarks 与普通对话的 `web:{userId}` 隔离到不同 daemon/队列;仅供后端编排的工作流运行使用。
 *          注意它也满足 isWebChatRuntimeId(以 'web:' 开头),计费/归属/outbox 路由口径与普通 chat 一致。
 */
export function getWebWorkflowRuntimeId(userId: string): string {
  return `${WEB_WORKFLOW_RUNTIME_PREFIX}${userId}`;
}

export function isWebChatRuntimeId(value: string): boolean {
  return value.startsWith(WEB_CHAT_RUNTIME_PREFIX);
}

/** 是否为 workflow 运行时键(`web:wf:…`)。 */
export function isWebWorkflowRuntimeId(value: string): boolean {
  return value.startsWith(WEB_WORKFLOW_RUNTIME_PREFIX);
}

export function getUserIdFromWebChatRuntimeId(value: string): string | null {
  // 必须先判更长的 workflow 前缀(web:wf:),否则会被 web: 前缀误剥成 'wf:{userId}',
  // 导致 owner/计费反查到错误(不存在)的用户。
  if (isWebWorkflowRuntimeId(value)) {
    const userId = value.slice(WEB_WORKFLOW_RUNTIME_PREFIX.length).trim();
    return userId || null;
  }
  if (!isWebChatRuntimeId(value)) return null;
  const userId = value.slice(WEB_CHAT_RUNTIME_PREFIX.length).trim();
  return userId || null;
}

export const WEB_CHAT_USER_NAME = '我';
export const WEB_CHAT_ASSISTANT_NAME = '命枢';
