'use client';

import { useEffect, useState } from 'react';
import { admin, clearAdminKey, getAdminKey, isAdminUnauthorizedError } from '@/lib/admin-api';
import { replaceAdminDocument } from '@/lib/admin-navigation';
import { AdminSidebar } from '@/components/admin-sidebar';

export default function AdminDashboardLayout({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    const key = getAdminKey();
    if (!key) {
      replaceAdminDocument('/admin');
      return;
    }
    admin
      .verify()
      .then(() => setAuthed(true))
      .catch((err) => {
        if (isAdminUnauthorizedError(err)) {
          clearAdminKey();
        }
        replaceAdminDocument('/admin');
      });
  }, []);

  if (!authed) {
    return (
      <div className="min-h-dvh flex items-center justify-center">
        <div className="w-4 h-4 border-2 border-muted border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <>
      <AdminSidebar />
      <main className="pt-14 lg:pt-0 lg:ml-56 min-h-dvh">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
          {children}
        </div>
      </main>
    </>
  );
}
