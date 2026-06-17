'use client';

import { createContext, useContext } from 'react';
import type { AdminSession } from '@/lib/admin-api';

const AdminSessionContext = createContext<AdminSession | null>(null);

/**
 * 向管理后台页面提供已经通过后端验证的管理员 session。
 */
export function AdminSessionProvider({
  session,
  children,
}: {
  session: AdminSession;
  children: React.ReactNode;
}) {
  return (
    <AdminSessionContext value={session}>{children}</AdminSessionContext>
  );
}

/**
 * 读取当前管理后台 session；只能在 dashboard layout 内部页面使用。
 */
export function useAdminSession(): AdminSession {
  const session = useContext(AdminSessionContext);
  if (!session) {
    throw new Error('useAdminSession must be used within AdminSessionProvider');
  }
  return session;
}
