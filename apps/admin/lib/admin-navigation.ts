import type {
  AdminHomePath,
  AdminRole,
  AdminScope,
  AdminSession,
} from '@/lib/admin-api';

function splitHref(href: string): { pathname: string; search: string } {
  const [pathname, ...rest] = href.split('?');
  return {
    pathname,
    search: rest.length > 0 ? `?${rest.join('?')}` : '',
  };
}

// 后端历史上会返回 /admin/* 作为管理后台 home path；独立 admin 站点以根路径承载，
// 所以导航层统一把旧路径转换成本站路径，避免牵动后端契约。
function toLocalAdminPathname(pathname: string): string {
  const normalized =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname;

  if (normalized === '/admin') return '/';
  if (normalized.startsWith('/admin/')) {
    return normalized.slice('/admin'.length) || '/';
  }
  return normalized || '/';
}

/**
 * 将后端历史 `/admin/*` 路径转换成独立 admin 站点本地路径。
 */
export function normalizeAdminPathname(pathname: string): string {
  return toLocalAdminPathname(pathname);
}

/**
 * 将管理后台 href 转成静态导出可直接访问的文档链接。
 */
export function toAdminDocumentHref(href: string): string {
  const { pathname, search } = splitHref(href);
  const localPathname = toLocalAdminPathname(pathname);
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

const ADMIN_ROLE_HOME_PATH: Record<AdminRole, AdminHomePath> = {
  owner: '/overview',
  user_manager: '/users',
};

/**
 * 按管理员身份返回默认首页；优先使用后端 session.home_path。
 */
export function getAdminHomePathForRole(role: AdminRole): AdminHomePath {
  return ADMIN_ROLE_HOME_PATH[role];
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
