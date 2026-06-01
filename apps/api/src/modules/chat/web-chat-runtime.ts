/**
 * 站内 AI Chat 的运行时会话键。
 *
 * 它不是微信账号，也不会写入 accounts 表；仅用于复用 agent-runtime
 * 现有的 Redis 队列、消息归档和 trace 归档分区能力。
 */

const WEB_CHAT_RUNTIME_PREFIX = 'web:';

export function getWebChatRuntimeId(userId: string): string {
  return `${WEB_CHAT_RUNTIME_PREFIX}${userId}`;
}

export function isWebChatRuntimeId(value: string): boolean {
  return value.startsWith(WEB_CHAT_RUNTIME_PREFIX);
}

export function getUserIdFromWebChatRuntimeId(value: string): string | null {
  if (!isWebChatRuntimeId(value)) return null;
  const userId = value.slice(WEB_CHAT_RUNTIME_PREFIX.length).trim();
  return userId || null;
}

export const WEB_CHAT_USER_NAME = '我';
export const WEB_CHAT_ASSISTANT_NAME = '命枢';
