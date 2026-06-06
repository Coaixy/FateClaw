import { normalizeAuthRedirect } from '@/lib/auth-redirect';

/**
 * 规范化站内返回路径。
 *
 * @param value 候选返回路径。
 * @returns 通过站内路径校验的返回路径；非法路径返回 null。
 */
export function normalizeReturnTo(value: string | null | undefined) {
  return normalizeAuthRedirect(value);
}

/**
 * 给站内返回路径追加启动向导恢复参数。
 *
 * @param path 已通过站内路径校验或调用方期望回到的路径。
 * @returns 可用于 href/router.push 的站内路径。
 */
export function appendGuideResume(path: string) {
  const normalized = normalizeReturnTo(path) ?? '/ai-chat';
  const url = new URL(normalized, 'https://fateclaw.local');
  url.searchParams.set('guide', 'resume');
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * 生成向导跳转到外部配置页时携带的返回参数。
 *
 * @param returnTo 配置完成后回到的站内路径。
 * @returns URLSearchParams 序列化后的 query 字符串。
 */
export function buildGuideReturnQuery(returnTo = '/ai-chat') {
  const params = new URLSearchParams();
  params.set('returnTo', normalizeReturnTo(returnTo) ?? '/ai-chat');
  params.set('guide', 'resume');
  return params.toString();
}
