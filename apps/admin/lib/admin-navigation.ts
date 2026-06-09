import type { AdminHomePath, AdminRole } from '@/lib/admin-api';

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

// Admin 独立站在生产静态导出下统一当作多页文档站点使用，
// 这里把路径规范成真实导出产物对应的尾斜杠形式。
export function normalizeAdminPathname(pathname: string): string {
  return toLocalAdminPathname(pathname);
}

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

export function replaceAdminDocument(href: string) {
  window.location.replace(toAdminDocumentHref(href));
}

const ADMIN_ROLE_HOME_PATH: Record<AdminRole, AdminHomePath> = {
  owner: '/overview',
  user_manager: '/users',
};

export function getAdminHomePathForRole(role: AdminRole): AdminHomePath {
  return ADMIN_ROLE_HOME_PATH[role];
}

export function canAdminRoleAccessPath(
  role: AdminRole,
  pathname: string,
): boolean {
  const normalizedPathname = normalizeAdminPathname(pathname);
  if (role === 'owner') {
    return normalizedPathname.startsWith('/');
  }
  return (
    normalizedPathname === '/users' || normalizedPathname === '/messages'
  );
}
