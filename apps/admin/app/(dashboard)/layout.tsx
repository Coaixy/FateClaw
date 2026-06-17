'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import {
  admin,
  clearAdminKey,
  getAdminKey,
  isAdminUnauthorizedError,
  type AdminSession,
} from '@/lib/admin-api';
import {
  canAdminSessionAccessPath,
  replaceAdminDocument,
  toAdminDocumentHref,
} from '@/lib/admin-navigation';
import { AdminSessionProvider } from '@/lib/admin-session';
import { AdminSidebar } from '@/components/admin-sidebar';

function PermissionDenied({ homePath }: { homePath: string }) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center text-center">
      <div className="rounded-xl border border-hairline bg-surface-card px-5 py-6">
        <h1 className="text-base font-semibold">无权访问该管理功能</h1>
        <p className="mt-2 text-[13px] leading-6 text-muted">
          当前管理密钥没有此页面需要的权限。请返回可访问的管理入口，或使用具备对应 scope 的管理密钥重新登录。
        </p>
        <a
          href={toAdminDocumentHref(homePath)}
          className="mt-4 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-[13px] font-medium text-on-primary"
        >
          返回可访问首页
        </a>
      </div>
    </div>
  );
}

export default function AdminDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [session, setSession] = useState<AdminSession | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);

  useEffect(() => {
    setSession(null);
    setAccessDenied(false);
    const key = getAdminKey();
    if (!key) {
      replaceAdminDocument('/');
      return;
    }
    admin
      .verify()
      .then((nextSession) => {
        setSession(nextSession);
        if (!canAdminSessionAccessPath(nextSession, pathname)) {
          setAccessDenied(true);
        }
      })
      .catch((err) => {
        if (isAdminUnauthorizedError(err)) {
          clearAdminKey();
        }
        replaceAdminDocument('/');
      });
  }, [pathname]);

  if (!session) {
    return (
      <div className="min-h-dvh flex items-center justify-center">
        <div className="w-4 h-4 border-2 border-muted border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <AdminSessionProvider session={session}>
      <AdminSidebar session={session} />
      <main className="pt-14 lg:pt-0 lg:ml-56 min-h-dvh">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
          {accessDenied ? (
            <PermissionDenied homePath={session.home_path} />
          ) : (
            children
          )}
        </div>
      </main>
    </AdminSessionProvider>
  );
}
