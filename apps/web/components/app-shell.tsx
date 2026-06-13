'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/features/auth/hooks/use-auth';
import {
  ChatSessionsProvider,
  useChatSessions,
} from '@/features/chat/hooks/use-chat-sessions';
import { buildLoginHref } from '@/lib/auth-redirect';
import { useI18n } from '@/lib/i18n';
import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';
import { ErrorBoundary } from './error-boundary';
import { AnnouncementBanner } from './announcements/announcement-banner';

/**
 * 应用外壳，负责统一处理登录态、侧边栏、顶部栏、内容区和合规备案页脚。
 *
 * @param props.children 页面主体内容。
 * @param props.wide 是否使用宽版内容容器。
 * @param props.noPadding 是否移除主内容底部内边距，常用于占满视口的聊天界面。
 * @param props.requireAuth 是否要求登录后访问；公开页面可关闭。
 * @returns 带全局导航、错误边界与合规备案页脚的页面框架。
 */
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
  const { t } = useI18n();
  const { user, loading, logout } = useAuth();
  const pathname = usePathname();
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
          <span>{t('shell.redirectingLogin')}</span>
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
          {t('shell.skipMain')}
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
            <AnnouncementBanner embedded wide={wide} />
            <ErrorBoundary>{children}</ErrorBoundary>
          </main>
          <ComplianceFooterSlot
            pathname={pathname}
            wide={wide}
            noPadding={noPadding}
          />
        </div>
      </div>
    </ChatSessionsProvider>
  );
}

function ComplianceFooterSlot({
  pathname,
  wide,
  noPadding,
}: {
  pathname: string | null;
  wide?: boolean;
  noPadding?: boolean;
}) {
  const { selectedSession } = useChatSessions();
  // 具体会话页已经进入盘面/解读上下文，隐藏备案页脚以免占用移动端输入区下方空间。
  const showComplianceFooter =
    pathname === '/' || (pathname === '/ai-chat' && !selectedSession);

  if (!showComplianceFooter) {
    return null;
  }

  return <SiteComplianceFooter wide={wide} noPadding={noPadding} />;
}

function SiteComplianceFooter({
  wide,
  noPadding,
}: {
  wide?: boolean;
  noPadding?: boolean;
}) {
  const { t } = useI18n();

  return (
    <footer
      aria-label={t('shell.complianceLabel')}
      className={`mx-auto ${
        wide ? 'max-w-[1400px] px-4 lg:px-8' : 'max-w-3xl px-4 lg:px-10'
      } ${noPadding ? 'py-4 lg:py-5' : 'pb-8 lg:pb-10'} text-center`}
    >
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t border-hairline/50 pt-4 text-[11px] leading-5 text-muted/70">
        <a
          href="https://beian.miit.gov.cn/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-6 items-center transition-colors hover:text-ink"
        >
          浙ICP备2024132053号
        </a>
        <span
          className="hidden h-3 w-px bg-hairline/70 sm:inline-block"
          aria-hidden="true"
        />
        <span className="inline-flex min-h-6 items-center">
          {t('shell.modelFiling')}
        </span>
      </div>
    </footer>
  );
}
