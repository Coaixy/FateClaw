import type { AdminHomePath, AdminRole } from '@/lib/admin-api';

function splitHref(href: string): { pathname: string; search: string } {
  const [pathname, ...rest] = href.split('?');
  return {
    pathname,
    search: rest.length > 0 ? `?${rest.join('?')}` : '',
  };
}

// Admin 区域在生产静态导出下统一当作多页文档站点使用，
// 这里把路径规范成真实导出产物对应的尾斜杠形式。
export function normalizeAdminPathname(pathname: string): string {
  if (pathname === '/admin/') return '/admin';
  if (pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

export function toAdminDocumentHref(href: string): string {
  const { pathname, search } = splitHref(href);
  const normalizedPathname =
    pathname === '/admin' || pathname === '/admin/'
      ? '/admin/'
      : pathname.endsWith('/')
        ? pathname
        : `${pathname}/`;
  return `${normalizedPathname}${search}`;
}

export function replaceAdminDocument(href: string) {
  window.location.replace(toAdminDocumentHref(href));
}

const ADMIN_ROLE_HOME_PATH: Record<AdminRole, AdminHomePath> = {
  owner: '/admin/overview',
  user_manager: '/admin/users',
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
    return normalizedPathname.startsWith('/admin');
  }
  return (
    normalizedPathname === '/admin/users' ||
    normalizedPathname === '/admin/messages'
  );
}
