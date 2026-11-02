export const DEFAULT_OWNED_CHAT_SESSION_TITLE = '未设置标题';

export function buildChatSessionTitleFromQuestion(question: string): string {
  const normalized = question.replace(/\s+/gu, ' ').trim();
  return Array.from(normalized).slice(0, 20).join('');
}

export function normalizeOwnedChatSessionTitle(
  title: string | null | undefined,
): string {
  const normalized = (title || '').trim();
  if (!normalized || normalized === '新对话') {
    return DEFAULT_OWNED_CHAT_SESSION_TITLE;
  }
  return normalized;
}
