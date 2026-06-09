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
  canAdminRoleAccessPath,
  replaceAdminDocument,
} from '@/lib/admin-navigation';
import { AdminSidebar } from '@/components/admin-sidebar';

export default function AdminDashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [session, setSession] = useState<AdminSession | null>(null);

  useEffect(() => {
    setSession(null);
    const key = getAdminKey();
    if (!key) {
      replaceAdminDocument('/');
      return;
    }
    admin
      .verify()
      .then((nextSession) => {
        if (!canAdminRoleAccessPath(nextSession.role, pathname)) {
          replaceAdminDocument(nextSession.home_path);
          return;
        }
        setSession(nextSession);
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
    <>
      <AdminSidebar role={session.role} />
      <main className="pt-14 lg:pt-0 lg:ml-56 min-h-dvh">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
          {children}
        </div>
      </main>
    </>
  );
}
