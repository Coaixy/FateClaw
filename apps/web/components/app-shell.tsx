'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { ChatSessionsProvider } from '@/features/chat/hooks/use-chat-sessions';
import { buildLoginHref } from '@/lib/auth-redirect';
import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';
import { ErrorBoundary } from './error-boundary';

export function AppShell({
  children,
  wide,
  noPadding,
  requireAuth = true,
}: {
  children: React.ReactNode;
  wide?: boolean;
  noPadding?: boolean;
  requireAuth?: boolean;
}) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (requireAuth && !loading && !user) {
      window.location.replace(buildLoginHref());
    }
  }, [loading, requireAuth, user]);

  if (requireAuth && loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center">
        <div className="w-4 h-4 border-2 border-muted border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (requireAuth && !user) {
    return (
      <div className="min-h-dvh flex items-center justify-center px-6">
        <div className="flex items-center gap-3 rounded-2xl border border-hairline bg-surface-card px-5 py-4 text-sm text-ink shadow-sm">
          <div className="w-4 h-4 border-2 border-muted border-t-transparent rounded-full animate-spin shrink-0" />
          <span>未检测到登录状态，正在跳转到登录页...</span>
        </div>
      </div>
    );
  }

  const handleLogout = () => {
    logout();
    router.replace('/login');
  };

  return (
    <ChatSessionsProvider>
      <div className="min-h-dvh">
        {/* Skip to main content — visible on focus */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[999] focus:px-4 focus:py-2 focus:rounded-lg focus:bg-ink focus:text-canvas focus:text-sm focus:font-medium"
        >
          跳到主要内容
        </a>

        {/* Global background grid & subtle glow */}
        <div className="fixed inset-0 pointer-events-none z-[-1] bg-canvas" aria-hidden="true">
          <div className="absolute inset-0 bg-[linear-gradient(to_right,color-mix(in_srgb,var(--color-ink)_2%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_srgb,var(--color-ink)_2%,transparent)_1px,transparent_1px)] bg-[size:48px_48px] opacity-30" />
          <div className="absolute top-0 right-0 w-[700px] h-[500px] bg-[radial-gradient(ellipse_at_top_right,color-mix(in_srgb,var(--color-primary)_6%,transparent),transparent_70%)]" />
          <div className="absolute bottom-0 left-0 w-[500px] h-[400px] bg-[radial-gradient(ellipse_at_bottom_left,color-mix(in_srgb,var(--color-accent-teal)_5%,transparent),transparent_70%)]" />
        </div>

        <Sidebar onLogout={handleLogout} />
        <div className="hidden lg:flex fixed top-4 right-6 z-30 items-center">
          <TopBar onLogout={handleLogout} />
        </div>
        {/* pt-14 for mobile top bar, lg: sidebar offset */}
        <div className="pt-14 lg:pt-0 lg:ml-[260px]">
          <main
            id="main-content"
            className={
              wide
                ? `mx-auto max-w-[1400px] px-4 ${noPadding ? 'pb-0' : 'pb-10'} lg:px-8 lg:pt-20 lg:pb-10 animate-page-enter`
                : `mx-auto max-w-3xl px-4 ${noPadding ? 'pb-0' : 'pb-10'} lg:px-10 lg:pt-20 lg:pb-10 animate-page-enter`
            }
          >
            <ErrorBoundary>{children}</ErrorBoundary>
          </main>
        </div>
      </div>
    </ChatSessionsProvider>
  );
}
