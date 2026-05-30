/**
 * 归一化登录后的站内回跳路径。
 *
 * 只接受站内绝对路径，避免登录页被用作开放重定向入口；同时排除登录页自身，
 * 防止已经登录的用户被带回登录页形成无意义跳转。
 */
export function normalizeAuthRedirect(value: string | null | undefined) {
  const path = value?.trim();
  if (!path || !path.startsWith('/') || path.startsWith('//')) {
    return null;
  }
  if (path === '/login' || path.startsWith('/login?')) {
    return null;
  }
  return path;
}

/**
 * 读取当前浏览器地址，作为登录完成后的默认回跳目标。
 *
 * 服务端渲染阶段没有 window，此时返回首页作为保守兜底。
 */
export function getCurrentAuthReturnPath() {
  if (typeof window === 'undefined') {
    return '/';
  }
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

/**
 * 构造登录页地址。
 *
 * next 参数只在目标通过站内路径校验后追加，调用方可以直接传入当前页面地址。
 */
export function buildLoginHref(nextPath = getCurrentAuthReturnPath()) {
  const redirect = normalizeAuthRedirect(nextPath);
  return redirect ? `/login?next=${encodeURIComponent(redirect)}` : '/login';
}

/**
 * 从当前登录页 URL 中读取安全的 next 参数。
 *
 * 默认值由调用方决定，常用于未携带 next 时回到 dashboard。
 */
export function readLoginRedirect(defaultPath: string) {
  if (typeof window === 'undefined') {
    return defaultPath;
  }
  const params = new URLSearchParams(window.location.search);
  return normalizeAuthRedirect(params.get('next')) ?? defaultPath;
}
