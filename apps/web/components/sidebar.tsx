'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  Archive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  LogIn,
  MessageCircle,
  Monitor,
  Share2,
  Menu,
  Moon,
  X,
  SquarePen,
  Search,
  Pencil,
  Check,
  Sun,
  ExternalLink,
  Send,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { useChatSessions } from '@/features/chat/hooks/use-chat-sessions';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { buildLoginHref } from '@/lib/auth-redirect';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';
import { ThemeMode, useTheme } from '@/lib/use-theme';
import { LanguageSwitcher } from './language-switcher';
import { TopBar } from './top-bar';

function formatSessionTime(
  ts: string,
  t: (key: string, params?: Record<string, string | number>) => string,
  formatDate: (
    value: string | number | Date,
    options?: Intl.DateTimeFormatOptions,
  ) => string,
) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return t('sidebar.today');
  if (days === 1) return t('sidebar.yesterday');
  if (days < 7) return t('sidebar.daysAgo', { days });
  return formatDate(d, { month: 'short', day: 'numeric' });
}

type SessionDateFilter = 'all' | 'today' | '7d' | '30d' | 'older';

const SESSION_DATE_FILTERS: readonly {
  value: SessionDateFilter;
  labelKey: string;
}[] = [
  { value: 'all', labelKey: 'sidebar.filters.all' },
  { value: 'today', labelKey: 'sidebar.filters.today' },
  { value: '7d', labelKey: 'sidebar.filters.sevenDays' },
  { value: '30d', labelKey: 'sidebar.filters.thirtyDays' },
  { value: 'older', labelKey: 'sidebar.filters.older' },
];
const SIDEBAR_SESSION_PREVIEW_LIMIT = 10;
const SESSION_PANEL_PAGE_SIZE = 6;

const SIDEBAR_THEME_OPTIONS: readonly {
  mode: ThemeMode;
  labelKey: string;
  icon: typeof Monitor;
}[] = [
  { mode: 'system', labelKey: 'sidebar.themes.system', icon: Monitor },
  { mode: 'light', labelKey: 'sidebar.themes.light', icon: Sun },
  { mode: 'dark', labelKey: 'sidebar.themes.dark', icon: Moon },
];
const TELEGRAM_CHANNEL_URL =
  process.env.NEXT_PUBLIC_TELEGRAM_CHANNEL_URL?.trim() ?? '';

type ContactQrType = 'wechat' | 'qq' | 'telegram';

function matchSessionDateFilter(
  updatedAt: string,
  filter: SessionDateFilter,
  now: Date,
) {
  if (filter === 'all') {
    return true;
  }

  const updatedTime = new Date(updatedAt).getTime();
  if (Number.isNaN(updatedTime)) {
    return false;
  }

  const dayMs = 86400000;
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();

  if (filter === 'today') {
    return updatedTime >= startOfToday;
  }

  if (filter === '7d') {
    return updatedTime >= startOfToday - 6 * dayMs;
  }

  if (filter === '30d') {
    return updatedTime >= startOfToday - 29 * dayMs;
  }

  return updatedTime < startOfToday - 29 * dayMs;
}

function SidebarSessionSkeleton() {
  const { t } = useI18n();
  const rows = ['w-28', 'w-36', 'w-24', 'w-32', 'w-28'];

  return (
    <div
      className="space-y-1.5 px-1 py-1"
      role="status"
      aria-label={t('sidebar.loadingSessions')}
    >
      <span className="sr-only">{t('sidebar.loadingSessions')}</span>
      {rows.map((widthClass, index) => (
        <div
          key={`${widthClass}-${index}`}
          className="flex items-center gap-2.5 rounded-xl px-3 py-2.5"
        >
          <div className="h-6 w-6 shrink-0 animate-pulse rounded-lg bg-surface-card" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div
              className={`h-3 animate-pulse rounded-full bg-muted/12 ${widthClass}`}
            />
            <div className="h-2 w-10 animate-pulse rounded-full bg-muted/10" />
          </div>
        </div>
      ))}
    </div>
  );
}

function Logo({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();

  return (
    <div className="flex items-center gap-2.5">
      <div className="relative">
        <div className="absolute inset-0 rounded-xl bg-primary/15 blur-md" />
        <div className="relative w-9 h-9 rounded-xl bg-canvas flex items-center justify-center border border-primary/25 shadow-sm">
          <svg viewBox="0 0 24 24" className="w-5 h-5 text-primary">
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />
            <circle cx="12" cy="8" r="2" fill="currentColor" />
            <circle cx="12" cy="16" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M12 2 A10 10 0 0 1 12 22" fill="currentColor" opacity="0.2" />
          </svg>
        </div>
      </div>
      {!compact && (
        <div className="flex flex-col">
          <span className="text-[15px] font-bold tracking-tight text-ink">
            {t('common.appName')}
          </span>
          <span className="text-[9px] text-primary/70 tracking-[0.2em] font-medium">
            FATECLAW
          </span>
        </div>
      )}
    </div>
  );
}

export function Sidebar({ onLogout }: { onLogout: () => void }) {
  const { formatDate, formatNumber, locale, t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const { toast } = useToast();
  const { loading: authLoading } = useAuth();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState<SessionDateFilter>('all');
  const [editingSessionId, setEditingSessionId] = useState('');
  const [editingTitle, setEditingTitle] = useState('');
  const [renamingSessionId, setRenamingSessionId] = useState('');
  const [sharingSessionId, setSharingSessionId] = useState('');
  const [contactOpen, setContactOpen] = useState(false);
  const [sessionsPanelOpen, setSessionsPanelOpen] = useState(false);
  const [sessionPanelPage, setSessionPanelPage] = useState(1);
  const [contactQrType, setContactQrType] =
    useState<ContactQrType>('wechat');
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  const activeThemeOption =
    SIDEBAR_THEME_OPTIONS.find((item) => item.mode === themeMode) ??
    SIDEBAR_THEME_OPTIONS[0];
  const ActiveThemeIcon = activeThemeOption.icon;
  const activeThemeLabel = t(activeThemeOption.labelKey);
  const cycleThemeMode = () => {
    const currentIndex = SIDEBAR_THEME_OPTIONS.findIndex(
      (item) => item.mode === themeMode,
    );
    const nextTheme =
      SIDEBAR_THEME_OPTIONS[(currentIndex + 1) % SIDEBAR_THEME_OPTIONS.length];

    setThemeMode(nextTheme.mode);
  };

  const {
    sessions,
    selectedSession,
    setSelectedSession,
    renameSession,
    archiveSession,
    shareSession,
    chatAvailable,
    loading: sessionsLoading,
  } = useChatSessions();

  useEffect(() => {
    setOpen(false);
    setSessionsPanelOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!contactOpen && !sessionsPanelOpen) {
      return;
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (contactOpen) {
          setContactOpen(false);
          return;
        }
        setSessionsPanelOpen(false);
      }
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [contactOpen, sessionsPanelOpen]);

  useEffect(() => {
    // 登录态变化后复位筛选和编辑态，避免用户误以为列表丢失。
    setSearch('');
    setDateFilter('all');
    setEditingSessionId('');
    setEditingTitle('');
    setRenamingSessionId('');
    setSharingSessionId('');
    setSessionsPanelOpen(false);
    setSessionPanelPage(1);
  }, [chatAvailable]);

  useEffect(() => {
    if (!editingSessionId) {
      return;
    }

    const currentSession = sessions.find(
      (session) => session.id === editingSessionId,
    );
    if (currentSession) {
      return;
    }

    setEditingSessionId('');
    setEditingTitle('');
    setRenamingSessionId('');
  }, [editingSessionId, sessions]);

  const closeSidebar = () => {
    setOpen(false);
    setSessionsPanelOpen(false);
  };

  // 搜索和日期筛选都只作用于展示层，不改动原始会话数组，避免影响当前选中和排序状态。
  const now = new Date();
  const dateFilteredSessions = sessions.filter((session) =>
    matchSessionDateFilter(session.updated_at, dateFilter, now),
  );
  const normalizedSearch = search.trim().toLowerCase();
  const filteredSessions = normalizedSearch
    ? dateFilteredSessions.filter((session) =>
        session.title.toLowerCase().includes(normalizedSearch),
      )
    : dateFilteredSessions;
  const sidebarPreviewSessions = filteredSessions.slice(
    0,
    SIDEBAR_SESSION_PREVIEW_LIMIT,
  );
  const sessionPanelPageCount = Math.max(
    1,
    Math.ceil(filteredSessions.length / SESSION_PANEL_PAGE_SIZE),
  );
  const currentSessionPanelPage = Math.min(
    sessionPanelPage,
    sessionPanelPageCount,
  );
  const pagedSessions = filteredSessions.slice(
    (currentSessionPanelPage - 1) * SESSION_PANEL_PAGE_SIZE,
    currentSessionPanelPage * SESSION_PANEL_PAGE_SIZE,
  );
  const activeDateFilterLabel =
    t(
      SESSION_DATE_FILTERS.find((item) => item.value === dateFilter)
        ?.labelKey ?? 'sidebar.filters.all',
    );
  const emptyStateMessage = normalizedSearch
    ? dateFilter === 'all'
      ? t('sidebar.noMatchedSearch', { query: search.trim() })
      : t('sidebar.noMatchedSearchInFilter', {
          query: search.trim(),
          filter: activeDateFilterLabel,
        })
    : dateFilter === 'all'
      ? t('sidebar.noSessions')
      : t('sidebar.noSessionsInFilter', { filter: activeDateFilterLabel });
  const showSessionSkeleton =
    sessions.length === 0 && (authLoading || sessionsLoading);
  const contactQrOptions: ContactQrType[] =
    locale === 'zh-CN' ? ['wechat', 'qq'] : ['telegram'];
  const activeContactQrType = contactQrOptions.includes(contactQrType)
    ? contactQrType
    : contactQrOptions[0];
  const contactQr =
    activeContactQrType === 'telegram'
      ? {
          kind: 'telegram' as const,
          title: t('sidebar.contact.telegramTitle'),
          subtitle: t('sidebar.contact.telegramSubtitle'),
          helper: t('sidebar.contact.telegramHelper'),
          url: TELEGRAM_CHANNEL_URL,
        }
      : activeContactQrType === 'wechat'
      ? {
          kind: 'qr' as const,
          title: t('sidebar.contact.stationmasterTitle'),
          subtitle: t('sidebar.contact.stationmasterSubtitle'),
          src: '/contact/honorary-stationmaster-wechat.jpg',
          alt: t('sidebar.contact.stationmasterAlt'),
          helper: t('sidebar.contact.stationmasterHelper'),
        }
      : {
          kind: 'qr' as const,
          title: t('sidebar.contact.groupTitle'),
          subtitle: t('sidebar.contact.groupSubtitle'),
          src: '/contact/shouyi-ai-qq-group.jpg',
          alt: t('sidebar.contact.groupAlt'),
          helper: t('sidebar.contact.groupHelper'),
        };

  useEffect(() => {
    setSessionPanelPage(1);
  }, [dateFilter, normalizedSearch]);

  useEffect(() => {
    setSessionPanelPage((page) => Math.min(page, sessionPanelPageCount));
  }, [sessionPanelPageCount]);

  const goNewChat = () => {
    // 手机端在当前页内切会话/新建对话时，pathname 不会变化，必须主动收起抽屉。
    setSessionsPanelOpen(false);
    closeSidebar();
    // 统一走 ChatSessionsProvider 的路由同步逻辑，避免这里再补一次 router.push
    // 把带参数的目标地址覆盖成裸 /ai-chat。
    setSelectedSession('');
  };

  const openChatSession = (sessionId: string) => {
    // 弹层里选会话后要同步收起，避免跳转到 AI Chat 后仍遮住主内容。
    setSessionsPanelOpen(false);
    closeSidebar();
    setSelectedSession(sessionId);
  };

  const resetEditingState = () => {
    setEditingSessionId('');
    setEditingTitle('');
    setRenamingSessionId('');
  };

  const startEditingSession = (sessionId: string, title: string) => {
    setEditingSessionId(sessionId);
    setEditingTitle(title);
    setRenamingSessionId('');
  };

  const copySessionShareLink = async (sessionId: string) => {
    if (sharingSessionId) return;
    setSharingSessionId(sessionId);
    try {
      const token = await shareSession(sessionId);
      const url = `${window.location.origin}/ai-chat/share?token=${encodeURIComponent(token)}`;
      await navigator.clipboard.writeText(url);
      toast('success', t('sidebar.shareCopied'));
    } catch (error) {
      toast(
        'error',
        error instanceof Error ? error.message : t('sidebar.shareFailed'),
      );
    } finally {
      setSharingSessionId('');
    }
  };

  const saveSessionTitle = async (sessionId: string) => {
    const normalizedTitle = editingTitle.trim();
    if (!normalizedTitle) {
      toast('error', t('sidebar.emptyTitle'));
      return;
    }

    const currentSession = sessions.find((session) => session.id === sessionId);
    if (!currentSession) {
      toast('error', t('sidebar.sessionMissing'));
      resetEditingState();
      return;
    }

    if (normalizedTitle === currentSession.title) {
      resetEditingState();
      return;
    }

    setRenamingSessionId(sessionId);

    try {
      await renameSession(sessionId, normalizedTitle);
      toast('success', t('sidebar.titleUpdated'));
      resetEditingState();
    } catch (error) {
      setRenamingSessionId('');
      toast(
        'error',
        error instanceof Error ? error.message : t('sidebar.titleUpdateFailed'),
      );
    }
  };

  return (
    <>
      {/* Mobile top bar：把菜单入口做成文字按钮，避免新用户误以为左上角只是装饰图标。 */}
      <header className="fixed top-0 left-0 right-0 h-14 z-40 lg:hidden">
        <div className="absolute inset-0 bg-canvas/85 backdrop-blur-xl" />
        <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-hairline/60 to-transparent" />

        <div className="relative h-full flex items-center justify-between px-3 gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <button
              onClick={() => setOpen((value) => !value)}
              className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border px-2.5 text-[12px] font-semibold shadow-sm transition-all duration-200 active:scale-95 ${
                open
                  ? 'border-primary/30 bg-primary/12 text-primary'
                  : 'border-hairline/70 bg-surface-card/80 text-ink hover:border-primary/30 hover:bg-primary/8'
              }`}
              aria-label={
                open ? t('sidebar.mobileMenuClose') : t('sidebar.mobileMenuOpen')
              }
              aria-expanded={open}
            >
              {open ? (
                <X size={16} strokeWidth={1.8} />
              ) : (
                <Menu size={16} strokeWidth={1.8} />
              )}
              <span>{open ? t('sidebar.collapse') : t('sidebar.menu')}</span>
            </button>
          </div>
          <TopBar compact onLogout={onLogout} />
        </div>
      </header>

      {/* Mobile drawer backdrop */}
      {open && (
        <div
          onClick={closeSidebar}
          className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40 lg:hidden animate-fade-in"
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed top-0 left-0 h-full w-[260px] bg-canvas border-r border-hairline flex flex-col z-50 transition-transform duration-300 ease-out lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >

        {/* Logo 区域 */}
        <div className="relative flex items-center justify-between px-5 h-16 shrink-0">
          <Logo />
          <button
            onClick={closeSidebar}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted hover:text-ink hover:bg-surface-card transition-all duration-200 cursor-pointer lg:hidden"
            aria-label={t('sidebar.closeMenu')}
          >
            <X size={16} />
          </button>
        </div>

        {/* 新建对话和归档入口 */}
        <div className="relative px-3 shrink-0">
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => setSessionsPanelOpen((value) => !value)}
              className={`flex h-12 min-w-0 items-center justify-between gap-2 rounded-xl border px-2.5 text-left shadow-sm transition-all duration-200 ${
                sessionsPanelOpen || normalizedSearch || dateFilter !== 'all'
                  ? 'border-primary/30 bg-primary/12 text-ink shadow-primary/5'
                  : 'border-hairline/70 bg-surface-card/75 text-muted hover:border-primary/30 hover:bg-primary/8 hover:text-ink'
              }`}
              aria-label={t('sidebar.openArchivePanel')}
              aria-expanded={sessionsPanelOpen}
              aria-haspopup="dialog"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
                  <Archive size={14} strokeWidth={1.8} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[11px] font-semibold leading-tight text-ink">
                    {t('sidebar.archive')}
                  </span>
                  <span className="mt-0.5 block truncate text-[10px] leading-none text-muted">
                    {formatNumber(filteredSessions.length)}/
                    {formatNumber(sessions.length)} · {activeDateFilterLabel}
                    {normalizedSearch ? ` · ${t('sidebar.searchActive')}` : ''}
                  </span>
                </span>
              </span>
              <ChevronDown
                size={13}
                strokeWidth={1.8}
                className={`shrink-0 transition-transform duration-200 ${
                  sessionsPanelOpen ? 'rotate-180 text-primary' : 'text-muted'
                }`}
              />
            </button>

            <button
              onClick={goNewChat}
              className="flex h-12 min-w-0 cursor-pointer items-center justify-center gap-2 rounded-xl border border-primary/20 bg-primary/10 px-2.5 text-[13px] font-semibold text-ink shadow-sm transition-all duration-200 hover:border-primary/40 hover:bg-primary/14"
              aria-label={t('sidebar.newChat')}
            >
              <SquarePen size={15} className="shrink-0 text-primary" />
              <span className="truncate">{t('sidebar.newChat')}</span>
            </button>
          </div>

          {sessionsPanelOpen && (
            <div
              role="dialog"
              aria-label={t('sidebar.archivePanel')}
              className="absolute left-3 right-3 top-full z-30 mt-2 overflow-hidden rounded-2xl border border-hairline/70 bg-canvas shadow-2xl"
            >
              <div className="flex items-center justify-between gap-2 border-b border-hairline/50 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-[12px] font-semibold text-ink">
                    {t('sidebar.archivePanel')}
                  </p>
                  <p className="text-[10px] leading-tight text-muted">
                    {t('common.count', { count: formatNumber(sessions.length) })}
                  </p>
                </div>
                <Link
                  href="/ai-chat/archive"
                  onClick={() => {
                    setSessionsPanelOpen(false);
                    closeSidebar();
                  }}
                  className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-hairline/60 bg-surface-card px-2 text-[11px] font-medium text-muted transition-all duration-200 hover:border-primary/25 hover:text-ink"
                  aria-label={t('sidebar.viewArchived')}
                  title={t('sidebar.archive')}
                >
                  <Archive size={12} strokeWidth={1.8} />
                  {t('sidebar.archived')}
                </Link>
              </div>

              <div className="space-y-2 px-3 py-3">
                <div className="relative">
                  <Search
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-muted/70"
                  />
                  <input
                    type="text"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t('sidebar.searchPlaceholder')}
                    className="h-9 w-full rounded-xl border border-hairline bg-canvas pl-9 pr-8 text-[12px] text-ink placeholder:text-muted/75 transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
                  />
                  {search && (
                    <button
                      type="button"
                      onClick={() => setSearch('')}
                      className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted/70 transition-all duration-200 hover:bg-surface-card hover:text-ink"
                      aria-label={t('sidebar.clearSearch')}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>

                <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-hide">
                  {SESSION_DATE_FILTERS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setDateFilter(item.value)}
                      className={`h-7 shrink-0 rounded-lg border px-2 text-[11px] font-medium transition-all duration-200 ${
                        dateFilter === item.value
                          ? 'border-primary/20 bg-primary/12 text-primary'
                          : 'border-hairline/60 bg-surface-card text-muted hover:border-primary/20 hover:text-ink'
                      }`}
                      aria-pressed={dateFilter === item.value}
                    >
                      {t(item.labelKey)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="max-h-[18.5rem] overflow-y-auto px-2 pb-2 scrollbar-hide">
                {showSessionSkeleton ? (
                  <SidebarSessionSkeleton />
                ) : sessions.length === 0 ? (
                  <div className="px-3 py-6 text-center">
                    <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-surface-card">
                      <MessageCircle size={16} className="text-muted/40" />
                    </div>
                    <p className="text-[11px] text-muted/60">
                      {chatAvailable
                        ? t('sidebar.noSessions')
                        : t('sidebar.loginToViewSessions')}
                    </p>
                  </div>
                ) : filteredSessions.length === 0 ? (
                  <div className="px-3 py-6 text-center">
                    <Search size={16} className="mx-auto text-muted/40" />
                    <p className="mt-2 text-[11px] text-muted/60">
                      {emptyStateMessage}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {pagedSessions.map((session) => {
                      const active =
                        session.id === selectedSession &&
                        pathname === '/ai-chat';

                      return (
                        <button
                          key={session.id}
                          type="button"
                          onClick={() => openChatSession(session.id)}
                          className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-all duration-200 ${
                            active
                              ? 'bg-primary/10 text-ink shadow-sm'
                              : 'text-muted hover:bg-surface-card hover:text-ink'
                          }`}
                        >
                          <div
                            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${
                              active
                                ? 'bg-primary/20 text-primary'
                                : 'bg-surface-card text-muted/60'
                            }`}
                          >
                            <MessageCircle size={12} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[12px] font-medium leading-tight">
                              {session.title}
                            </p>
                            <p className="mt-0.5 text-[10px] leading-tight text-muted/50">
                              {formatSessionTime(
                                session.updated_at,
                                t,
                                formatDate,
                              )}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between gap-2 border-t border-hairline/50 px-3 py-2">
                <span className="text-[10px] text-muted">
                  {filteredSessions.length === 0
                    ? t('common.pageStatus', { current: 0, total: 0 })
                    : t('common.pageStatus', {
                        current: formatNumber(currentSessionPanelPage),
                        total: formatNumber(sessionPanelPageCount),
                      })}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      setSessionPanelPage((page) => Math.max(1, page - 1))
                    }
                    disabled={currentSessionPanelPage <= 1}
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-all duration-200 hover:bg-surface-card hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
                    aria-label={t('sidebar.previousPage')}
                  >
                    <ChevronLeft size={13} strokeWidth={1.8} />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setSessionPanelPage((page) =>
                        Math.min(sessionPanelPageCount, page + 1),
                      )
                    }
                    disabled={currentSessionPanelPage >= sessionPanelPageCount}
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-all duration-200 hover:bg-surface-card hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
                    aria-label={t('sidebar.nextPage')}
                  >
                    <ChevronRight size={13} strokeWidth={1.8} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 对话历史列表 */}
        <div className="relative flex-1 min-h-0 flex flex-col mt-3">
          <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 scrollbar-hide">
            {showSessionSkeleton ? (
              <SidebarSessionSkeleton />
            ) : sessions.length === 0 ? (
              <div className="px-3 py-6 text-center">
                <div className="w-10 h-10 mx-auto mb-2 rounded-full bg-surface-card flex items-center justify-center">
                  <MessageCircle size={16} className="text-muted/40" />
                </div>
                <p className="text-[11px] text-muted/60">
                  {chatAvailable
                    ? t('sidebar.noSessions')
                    : t('sidebar.loginToViewSessions')}
                </p>
                {!chatAvailable && (
                  <button
                    type="button"
                    onClick={() => router.push(buildLoginHref())}
                    className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-hairline bg-surface-card px-3 text-[11px] font-medium text-ink transition-colors hover:border-primary/35 hover:bg-primary/10"
                  >
                    <LogIn size={12} className="text-primary" />
                    {t('common.login')}
                  </button>
                )}
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="px-3 py-6 text-center">
                <div className="w-10 h-10 mx-auto mb-2 rounded-full bg-surface-card flex items-center justify-center">
                  <Search size={16} className="text-muted/40" />
                </div>
                <p className="text-[11px] text-muted/60">
                  {emptyStateMessage}
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                {sidebarPreviewSessions.map((session) => {
                  const active = session.id === selectedSession && pathname === '/ai-chat';
                  const isEditing = session.id === editingSessionId;
                  const isRenaming = session.id === renamingSessionId;
                  const isSharing = session.id === sharingSessionId;
                  const openSession = () => {
                    openChatSession(session.id);
                  };

                  if (isEditing) {
                    // 编辑态切成静态容器，避免 input / 按钮冒泡后误触发会话切换。
                    return (
                      <div
                        key={session.id}
                        className={`w-full px-3 py-3 rounded-xl border transition-all duration-200 ${
                          active
                            ? 'border-primary/40 bg-primary/10'
                            : 'border-hairline/60 bg-surface-card/70'
                        }`}
                      >
                        <div className="flex items-start gap-2.5">
                          <div
                            className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 transition-colors duration-200 ${
                              active
                                ? 'bg-primary/20 text-primary'
                                : 'bg-surface-card text-muted/60'
                            }`}
                          >
                            <MessageCircle size={12} />
                          </div>
                          <div className="flex-1 min-w-0 space-y-2">
                            <input
                              type="text"
                              value={editingTitle}
                              autoFocus
                              maxLength={80}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) => setEditingTitle(event.target.value)}
                              onKeyDown={(event) => {
                                event.stopPropagation();

                                if (event.key === 'Enter') {
                                  event.preventDefault();
                                  void saveSessionTitle(session.id);
                                }

                                if (event.key === 'Escape' && !isRenaming) {
                                  event.preventDefault();
                                  resetEditingState();
                                }
                              }}
                              className="w-full h-9 rounded-lg border border-hairline bg-canvas px-3 text-[12px] text-ink placeholder:text-muted focus:border-primary focus:ring-1 focus:ring-primary/20 focus:outline-none transition-all"
                              aria-label={t('sidebar.editTitle')}
                            />
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-[10px] text-muted/55 leading-tight">
                                {formatSessionTime(
                                  session.updated_at,
                                  t,
                                  formatDate,
                                )}
                              </p>
                              <div className="flex items-center gap-1.5">
                                <button
                                  onClick={() => void saveSessionTitle(session.id)}
                                  disabled={isRenaming}
                                  className="h-7 px-2.5 rounded-lg flex items-center gap-1 text-[11px] font-medium bg-primary/12 text-primary hover:bg-primary/18 transition-all duration-200 cursor-pointer disabled:opacity-60 disabled:cursor-wait"
                                >
                                  <Check size={12} />
                                  {isRenaming
                                    ? t('common.saving')
                                    : t('common.save')}
                                </button>
                                <button
                                  onClick={resetEditingState}
                                  disabled={isRenaming}
                                  className="h-7 px-2.5 rounded-lg text-[11px] font-medium text-muted hover:text-ink hover:bg-surface-card transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  {t('common.cancel')}
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={session.id}
                      role="button"
                      tabIndex={0}
                      onClick={openSession}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openSession();
                        }
                      }}
                      className={`group w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left transition-all duration-200 cursor-pointer ${
                        active
                          ? 'bg-primary/10 text-ink shadow-sm'
                          : 'text-muted hover:text-ink hover:bg-surface-card'
                      }`}
                    >
                      <div
                        className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 transition-colors duration-200 ${
                          active
                            ? 'bg-primary/20 text-primary'
                            : 'bg-surface-card text-muted/60'
                        }`}
                      >
                        <MessageCircle size={12} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-[12px] font-medium leading-tight">
                          {session.title}
                        </p>
                        <p className="text-[10px] text-muted/50 leading-tight mt-0.5">
                          {formatSessionTime(
                            session.updated_at,
                            t,
                            formatDate,
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            void copySessionShareLink(session.id);
                          }}
                          disabled={Boolean(sharingSessionId)}
                          className="w-5 h-5 rounded flex items-center justify-center opacity-60 lg:opacity-0 lg:group-hover:opacity-60 hover:!opacity-100 text-muted hover:text-primary hover:bg-primary/10 transition-all duration-200 cursor-pointer disabled:cursor-wait disabled:opacity-40"
                          aria-label={t('sidebar.copyShareLink')}
                        >
                          {isSharing ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : (
                            <Share2 size={11} />
                          )}
                        </button>
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            startEditingSession(session.id, session.title);
                          }}
                          className="w-5 h-5 rounded flex items-center justify-center opacity-60 lg:opacity-0 lg:group-hover:opacity-60 hover:!opacity-100 text-muted hover:text-primary hover:bg-primary/10 transition-all duration-200 cursor-pointer"
                          aria-label={t('sidebar.modifyTitle')}
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void archiveSession(session.id)
                              .then(() =>
                                toast('success', t('sidebar.archivedToast')),
                              )
                              .catch((error) => {
                                toast(
                                  'error',
                                  error instanceof Error
                                    ? error.message
                                    : t('sidebar.archiveFailed'),
                                );
                              });
                          }}
                          className="w-5 h-5 rounded flex items-center justify-center opacity-60 lg:opacity-0 lg:group-hover:opacity-60 hover:!opacity-100 text-muted hover:text-primary hover:bg-primary/10 transition-all duration-200 cursor-pointer"
                          aria-label={t('sidebar.archiveChat')}
                          title={t('sidebar.archiveChat')}
                        >
                          <Archive size={11} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* 底部：紧凑入口和全局外观偏好，尽量把纵向空间留给对话历史。 */}
        <div className="relative px-3 py-3 shrink-0">
          <div className="absolute top-0 left-4 right-4 h-px bg-gradient-to-r from-transparent via-hairline/40 to-transparent" />

          <div className="mb-2">
            <LanguageSwitcher compact />
          </div>

          <div
            className="grid grid-cols-3 gap-1 rounded-xl border border-hairline/60 bg-surface-card/60 p-1"
            role="group"
            aria-label={t('sidebar.shortcutsAndTheme')}
          >
            <Link
              href="/status"
              onClick={closeSidebar}
              className={`group flex h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium transition-all duration-200 ${
                pathname === '/status'
                  ? 'bg-primary/10 text-ink'
                  : 'text-muted hover:text-ink hover:bg-surface-card'
              }`}
              aria-label={t('sidebar.viewStatus')}
              title={t('sidebar.status')}
            >
              <Activity
                size={14}
                strokeWidth={1.8}
                className="group-hover:text-primary"
              />
              <span className="max-w-full truncate leading-tight">
                {t('sidebar.status')}
              </span>
            </Link>

            <button
              type="button"
              onClick={() => {
                setContactQrType(locale === 'zh-CN' ? 'wechat' : 'telegram');
                setContactOpen(true);
              }}
              className="group flex h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium text-muted transition-all duration-200 hover:bg-surface-card hover:text-ink"
              aria-label={t('sidebar.contactStationmaster')}
              title={t('sidebar.contactStationmaster')}
            >
              <MessageCircle
                size={14}
                strokeWidth={1.8}
                className="group-hover:text-primary"
              />
              <span className="max-w-full truncate leading-tight">
                {t('sidebar.contactShort')}
              </span>
            </button>

            <button
              type="button"
              onClick={cycleThemeMode}
              className="flex h-11 min-w-0 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg bg-primary/12 text-[10px] font-medium text-primary shadow-sm transition-all duration-200 hover:bg-primary/18"
              aria-label={t('sidebar.switchTheme', {
                theme: activeThemeLabel,
              })}
              title={t('sidebar.currentTheme', { theme: activeThemeLabel })}
            >
              <ActiveThemeIcon size={14} strokeWidth={1.8} />
              <span className="max-w-full truncate leading-tight">
                {activeThemeLabel}
              </span>
            </button>
          </div>
        </div>
      </aside>

      {contactOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 px-4 py-6 backdrop-blur-sm animate-fade-in"
          onClick={() => setContactOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="contact-stationmaster-title"
            className="w-full max-w-[320px] rounded-2xl border border-hairline bg-canvas p-4 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p
                  id="contact-stationmaster-title"
                  className="truncate text-[15px] font-semibold text-ink"
                >
                  {contactQr.title}
                </p>
                <p className="mt-0.5 text-[11px] text-muted">
                  {contactQr.subtitle}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setContactOpen(false)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-all duration-200 hover:bg-surface-card hover:text-ink"
                aria-label={t('sidebar.contact.close')}
              >
                <X size={16} />
              </button>
            </div>

            {contactQrOptions.length > 1 && (
              <div
                className="mt-4 grid grid-cols-2 gap-1 rounded-xl border border-hairline/60 bg-surface-card/60 p-1"
                role="group"
                aria-label={t('sidebar.contact.choose')}
              >
                {contactQrOptions.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setContactQrType(option)}
                    className={`h-8 rounded-lg text-[12px] font-medium transition-all duration-200 ${
                      activeContactQrType === option
                        ? 'bg-primary/12 text-primary shadow-sm'
                        : 'text-muted hover:bg-canvas hover:text-ink'
                    }`}
                    aria-pressed={activeContactQrType === option}
                  >
                    {option === 'wechat'
                      ? t('sidebar.contact.stationmasterTab')
                      : option === 'qq'
                        ? t('sidebar.contact.qqGroupTab')
                        : t('sidebar.contact.telegramTab')}
                  </button>
                ))}
              </div>
            )}

            {contactQr.kind === 'telegram' ? (
              <div className="mt-4 rounded-xl border border-hairline bg-surface-card p-4 text-center">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                  <Send size={19} strokeWidth={1.8} aria-hidden="true" />
                </span>
                <p className="mt-3 text-[13px] font-semibold text-ink">
                  {t('sidebar.contact.telegramChannelLabel')}
                </p>
                {contactQr.url ? (
                  <a
                    href={contactQr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-semibold text-on-primary transition-colors hover:bg-primary-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
                  >
                    {t('sidebar.contact.telegramOpen')}
                    <ExternalLink size={13} aria-hidden="true" />
                  </a>
                ) : (
                  <p className="mt-3 rounded-lg border border-hairline bg-canvas px-3 py-2 text-[11px] leading-5 text-muted">
                    {t('sidebar.contact.telegramMissing')}
                  </p>
                )}
              </div>
            ) : (
              <div className="mt-4 rounded-xl border border-hairline bg-white p-3">
                <img
                  src={contactQr.src}
                  alt={contactQr.alt}
                  className="max-h-[58dvh] w-full rounded-lg object-contain"
                />
              </div>
            )}

            <p className="mt-3 text-center text-[12px] text-muted">
              {contactQr.helper}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
