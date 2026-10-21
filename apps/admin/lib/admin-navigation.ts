import type { AdminScope, AdminSession } from '@/lib/admin-api';

function splitHref(href: string): { pathname: string; search: string } {
  const [pathname, ...rest] = href.split('?');
  return {
    pathname,
    search: rest.length > 0 ? `?${rest.join('?')}` : '',
  };
}

export function normalizeAdminPathname(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/')
    ? pathname.slice(0, -1)
    : pathname || '/';
}

/**
 * 将管理后台 href 转成静态导出可直接访问的文档链接。
 */
export function toAdminDocumentHref(href: string): string {
  const { pathname, search } = splitHref(href);
  const localPathname = normalizeAdminPathname(pathname);
  const normalizedPathname =
    localPathname === '/'
      ? '/'
      : localPathname.endsWith('/')
        ? localPathname
        : `${localPathname}/`;
  return `${normalizedPathname}${search}`;
}

/**
 * 使用静态文档路径执行整页替换跳转。
 */
export function replaceAdminDocument(href: string) {
  window.location.replace(toAdminDocumentHref(href));
}

/**
 * 判断一个管理员 scope 集合是否满足目标能力。
 */
export function hasAdminScope(
  scopes: readonly AdminScope[],
  required: AdminScope,
): boolean {
  return scopes.includes('admin:*') || scopes.includes(required);
}

/**
 * 返回本地管理路径所需的最小 scope。
 */
export function getRequiredAdminScopeForPath(
  pathname: string,
): AdminScope | null {
  const normalizedPathname = normalizeAdminPathname(pathname);
  if (normalizedPathname === '/') return null;
  if (
    normalizedPathname === '/users' ||
    normalizedPathname.startsWith('/users/')
  ) {
    return 'users:read';
  }
  if (
    normalizedPathname === '/messages' ||
    normalizedPathname.startsWith('/messages/')
  ) {
    return 'messages:read';
  }
  return 'admin:*';
}

/**
 * 判断当前管理端 session 是否能访问指定本地路径。
 */
export function canAdminSessionAccessPath(
  session: Pick<AdminSession, 'scopes'>,
  pathname: string,
): boolean {
  const requiredScope = getRequiredAdminScopeForPath(pathname);
  return requiredScope ? hasAdminScope(session.scopes, requiredScope) : true;
}
