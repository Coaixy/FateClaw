export const DEFAULT_OWNED_CHAT_SESSION_TITLE = '未设置标题';

export function normalizeOwnedChatSessionTitle(
  title: string | null | undefined,
): string {
  const normalized = (title || '').trim();
  if (!normalized || normalized === '新对话') {
    return DEFAULT_OWNED_CHAT_SESSION_TITLE;
  }
  return normalized;
}
