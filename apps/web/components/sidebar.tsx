'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Archive,
  Activity,
  Megaphone,
  CircleDot,
  Heart,
  History,
  Loader2,
  LogIn,
  MessageCircle,
  Monitor,
  Share2,
  Menu,
  Moon,
  X,
  Search,
  Pencil,
  PanelLeftClose,
  PanelLeftOpen,
  Check,
  SquarePen,
  Sun,
  Users,
} from 'lucide-react';
import { useReducer, useState, useEffect, useMemo } from 'react';
import { isAiChatPath, useChatSessions } from '@/features/chat/hooks/use-chat-sessions';
import { useClientProfiles } from '@/features/chat/hooks/use-client-profiles';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { useIssueUnreadCount } from '@/features/issues/use-issue-unread';
import { buildLoginHref } from '@/lib/auth-redirect';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';
import { ThemeMode, useTheme } from '@/lib/use-theme';
import { BrandSeal } from './brand/brand-marks';
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

const SIDEBAR_THEME_OPTIONS: readonly {
  mode: ThemeMode;
  labelKey: string;
  icon: typeof Monitor;
}[] = [
  { mode: 'system', labelKey: 'sidebar.themes.system', icon: Monitor },
  { mode: 'light', labelKey: 'sidebar.themes.light', icon: Sun },
  { mode: 'dark', labelKey: 'sidebar.themes.dark', icon: Moon },
];

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
          <div className="h-6 w-6 shrink-0 animate-pulse rounded-lg bg-canvas/60" />
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
      {/* 品牌方印:「守义」白文印,宣纸朱砂主题的点睛元素。 */}
      <BrandSeal className="h-9 w-9 shadow-sm" />
      {!compact && (
        <div className="flex flex-col">
          <span className="font-display text-[15px] font-bold tracking-tight text-ink">
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

// Reset transient list state together when authentication changes.
type SessionListState = {
  search: string;
  dateFilter: SessionDateFilter;
  editingSessionId: string;
  editingTitle: string;
  renamingSessionId: string;
  sessionsPanelOpen: boolean;
};

const INITIAL_SESSION_LIST_STATE: SessionListState = {
  search: '',
  dateFilter: 'all',
  editingSessionId: '',
  editingTitle: '',
  renamingSessionId: '',
  sessionsPanelOpen: false,
};

type SessionListAction =
  | { type: 'reset' } // 登录态变化后整体复位
  | { type: 'closePanel' } // 收起展开的会话面板
  | { type: 'clearEditing' } // 退出行内改名
  | { type: 'startEditing'; sessionId: string; title: string }
  | { type: 'setEditingTitle'; title: string }
  | { type: 'setRenaming'; sessionId: string };

function sessionListReducer(
  state: SessionListState,
  action: SessionListAction,
): SessionListState {
  switch (action.type) {
    case 'reset':
      return INITIAL_SESSION_LIST_STATE;
    case 'closePanel':
      return { ...state, sessionsPanelOpen: false };
    case 'clearEditing':
      return {
        ...state,
        editingSessionId: '',
        editingTitle: '',
        renamingSessionId: '',
      };
    case 'startEditing':
      return {
        ...state,
        editingSessionId: action.sessionId,
        editingTitle: action.title,
        renamingSessionId: '',
      };
    case 'setEditingTitle':
      return { ...state, editingTitle: action.title };
    case 'setRenaming':
      return { ...state, renamingSessionId: action.sessionId };
    default:
      return state;
  }
}

export function Sidebar({
  collapsed,
  onToggleCollapsed,
  onLogout,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onLogout: () => void;
}) {
  const { formatDate, formatNumber, t } = useI18n();
  const pathname = usePathname();
  const isHistoryPage = pathname === '/history' || pathname === '/history/';
  const router = useRouter();
  const { toast } = useToast();
  const { loading: authLoading, user } = useAuth();
  const issueUnread = useIssueUnreadCount(user?.id, true);
  const [open, setOpen] = useState(false);
  const toggleLabel = t(
    collapsed ? 'sidebar.expandSidebar' : 'sidebar.collapseSidebar',
  );
  const [sessionList, dispatchSessionList] = useReducer(
    sessionListReducer,
    INITIAL_SESSION_LIST_STATE,
  );
  const {
    search,
    dateFilter,
    editingSessionId,
    editingTitle,
    renamingSessionId,
    sessionsPanelOpen,
  } = sessionList;
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

  // 侧栏内静默加载客户档案，仅用于把会话上的 client_id 在内存里 join 成客户名展示。
  // 失败时不打扰用户（不弹 toast），缺失客户名时会话标题照常显示。
  const { profiles: clientProfiles, loadProfiles: loadClientProfiles } =
    useClientProfiles(() => {});
  const hasSessionWithClient = useMemo(
    () => sessions.some((session) => Boolean(session.client_id)),
    [sessions],
  );
  const clientNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const profile of clientProfiles) {
      map.set(profile.id, profile.name);
    }
    return map;
  }, [clientProfiles]);

  useEffect(() => {
    // 只有存在关联客户的会话时才拉取客户档案，避免无谓请求。
    if (!chatAvailable || !hasSessionWithClient) {
      return;
    }
    void loadClientProfiles().catch(() => {});
  }, [chatAvailable, hasSessionWithClient, loadClientProfiles]);

  useEffect(() => {
    setOpen(false);
    dispatchSessionList({ type: 'closePanel' });
  }, [pathname]);

  useEffect(() => {
    if (!sessionsPanelOpen) {
      return;
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        dispatchSessionList({ type: 'closePanel' });
      }
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [sessionsPanelOpen]);

  useEffect(() => {
    // 登录态变化后复位筛选和编辑态，避免用户误以为列表丢失。
    dispatchSessionList({ type: 'reset' });
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

    dispatchSessionList({ type: 'clearEditing' });
  }, [editingSessionId, sessions]);

  const closeSidebar = () => {
    setOpen(false);
    dispatchSessionList({ type: 'closePanel' });
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

  const openChatSession = (sessionId: string) => {
    // 弹层里选会话后要同步收起，避免跳转到 AI Chat 后仍遮住主内容。
    dispatchSessionList({ type: 'closePanel' });
    closeSidebar();
    setSelectedSession(sessionId);
  };

  const resetEditingState = () => {
    dispatchSessionList({ type: 'clearEditing' });
  };

  const startEditingSession = (sessionId: string, title: string) => {
    dispatchSessionList({ type: 'startEditing', sessionId, title });
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

    dispatchSessionList({ type: 'setRenaming', sessionId });

    try {
      await renameSession(sessionId, normalizedTitle);
      toast('success', t('sidebar.titleUpdated'));
      resetEditingState();
    } catch (error) {
      dispatchSessionList({ type: 'setRenaming', sessionId: '' });
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
              className={`relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border px-2.5 text-[12px] font-semibold shadow-sm transition-all duration-200 active:scale-95 ${
                open
                  ? 'border-primary/30 bg-primary/12 text-primary'
                  : 'border-hairline/70 bg-surface-card/80 text-ink hover:border-primary/30 hover:bg-primary/8'
              }`}
              aria-label={
                open ? t('sidebar.mobileMenuClose') : t('sidebar.mobileMenuOpen')
              }
              aria-expanded={open}
              aria-controls="app-sidebar"
            >
              {open ? (
                <X size={16} strokeWidth={1.8} />
              ) : (
                <Menu size={16} strokeWidth={1.8} />
              )}
              <span>{open ? t('sidebar.collapse') : t('sidebar.menu')}</span>
              {issueUnread > 0 && !open && (
                <span
                  aria-hidden="true"
                  className="absolute -right-1 -top-1 size-2.5 rounded-full bg-primary ring-2 ring-canvas"
                />
              )}
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
      {/* 侧栏专用深底色(sidebar token,比画布深约 6%):与主画布形成肉眼可见的双色分层,
          这是整页结构层次的地基。 */}
      <aside
        id="app-sidebar"
        className={`fixed top-0 left-0 h-full w-[260px] bg-sidebar border-r border-hairline flex flex-col z-50 transition-[width,transform] duration-300 ease-out motion-reduce:transition-none lg:translate-x-0 ${collapsed ? 'lg:w-16' : ''} ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >

        {/* Logo 区域：点击后统一回到新建对话首屏。 */}
        <div
          className={`relative flex h-16 shrink-0 items-center justify-between px-5 ${collapsed ? 'lg:justify-center lg:px-3' : ''}`}
        >
          <button
            type="button"
            onClick={() => {
              closeSidebar();
              setSelectedSession('');
            }}
            className={`cursor-pointer rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 ${collapsed ? 'lg:hidden' : ''}`}
            aria-label={t('hub.newChat')}
          >
            <Logo />
          </button>
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="hidden h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors hover:bg-canvas/70 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 lg:flex"
            aria-label={toggleLabel}
            title={toggleLabel}
            aria-expanded={!collapsed}
            aria-controls="app-sidebar"
          >
            {collapsed ? (
              <PanelLeftOpen size={18} strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={18} strokeWidth={1.8} aria-hidden="true" />
            )}
          </button>
          <button
            onClick={closeSidebar}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted hover:text-ink hover:bg-canvas/70 transition-all duration-200 cursor-pointer lg:hidden"
            aria-label={t('sidebar.closeMenu')}
          >
            <X size={16} />
          </button>
        </div>

        {/* 主操作：新建对话独占一行。技能开发/客户档案已移至新建对话选择页与 /history 页脚注。 */}
        <div className="relative px-3 shrink-0">
          <button
            type="button"
            onClick={() => {
              closeSidebar();
              // 清空选中会话 → ChatSessionsProvider 自动跳转 /ai-chat 开新对话
              setSelectedSession('');
            }}
            className={`flex h-10 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-3 text-[13px] font-semibold text-primary transition-colors duration-200 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 ${collapsed ? 'lg:w-10 lg:justify-center lg:px-0' : ''}`}
            aria-label={t('hub.newChat')}
            title={t('hub.newChat')}
          >
            <SquarePen
              size={15}
              strokeWidth={2}
              className={`shrink-0 ${collapsed ? 'lg:size-[18px]' : ''}`}
            />
            <span className={`truncate ${collapsed ? 'lg:hidden' : ''}`}>
              {t('hub.newChat')}
            </span>
          </button>
        </div>

        {collapsed && (
          <div className="relative hidden min-h-0 flex-1 px-3 pt-2 lg:block">
            <Link
              href="/history"
              onClick={closeSidebar}
              className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors hover:bg-canvas/70 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 ${
                isHistoryPage
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted'
              }`}
              aria-label={t('sidebar.chatHistory')}
              title={t('sidebar.chatHistory')}
              aria-current={isHistoryPage ? 'page' : undefined}
            >
              <History size={18} strokeWidth={1.8} aria-hidden="true" />
            </Link>
          </div>
        )}

        {/* 对话历史列表:节标签让列表区有明确的分组起点(对齐 Claude 侧栏的 Recents)。 */}
        <div
          className={`relative flex-1 min-h-0 flex flex-col mt-5 ${collapsed ? 'lg:hidden' : ''}`}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 pl-5 pr-3 pb-1.5">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted/60">
              <span className="h-3 w-[2.5px] rounded-full bg-primary/70" aria-hidden="true" />
              {t('hub.recentChats')}
            </p>
            <Link
              href="/history"
              onClick={closeSidebar}
              className="inline-flex h-6 items-center rounded-md px-1.5 text-[11px] font-medium text-muted transition-colors hover:bg-canvas/70 hover:text-primary"
              aria-label={t('hub.viewAllChats')}
            >
              {t('hub.viewAllChats')}
            </Link>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 scrollbar-hide">
            {showSessionSkeleton ? (
              <SidebarSessionSkeleton />
            ) : sessions.length === 0 ? (
              <div className="px-3 py-6 text-center">
                <div className="w-10 h-10 mx-auto mb-2 rounded-full bg-canvas/70 flex items-center justify-center">
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
                    className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-hairline bg-canvas/70 px-3 text-[11px] font-medium text-ink transition-colors hover:border-primary/35 hover:bg-primary/10"
                  >
                    <LogIn size={12} className="text-primary" />
                    {t('common.login')}
                  </button>
                )}
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="px-3 py-6 text-center">
                <div className="w-10 h-10 mx-auto mb-2 rounded-full bg-canvas/70 flex items-center justify-center">
                  <Search size={16} className="text-muted/40" />
                </div>
                <p className="text-[11px] text-muted/60">
                  {emptyStateMessage}
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {sidebarPreviewSessions.map((session) => {
                  const active = session.id === selectedSession && isAiChatPath(pathname);
                  const isEditing = session.id === editingSessionId;
                  const isRenaming = session.id === renamingSessionId;
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
                            : 'border-hairline/60 bg-canvas/60'
                        }`}
                      >
                        <div className="flex items-start">
                          <div className="flex-1 min-w-0 space-y-2">
                            <input
                              type="text"
                              value={editingTitle}
                              autoFocus
                              maxLength={80}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) =>
                                dispatchSessionList({
                                  type: 'setEditingTitle',
                                  title: event.target.value,
                                })
                              }
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
                                  className="h-7 px-2.5 rounded-lg text-[11px] font-medium text-muted hover:text-ink hover:bg-canvas/70 transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
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
                      className={`group w-full flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl text-left border transition-all duration-200 cursor-pointer ${
                        active
                          ? 'bg-primary/10 border-primary/25 shadow-sm text-ink'
                          : 'bg-canvas/80 border-transparent text-body-strong hover:bg-surface-raised hover:border-hairline hover:shadow-sm hover:text-ink'
                      }`}
                    >
                      <div className="mt-0.5 shrink-0">
                        <MessageCircle
                          size={14}
                          strokeWidth={1.8}
                          className={active ? 'text-primary' : 'text-muted/40'}
                          aria-hidden="true"
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-[13px] font-medium leading-snug text-ink">
                          {session.title}
                        </p>
                        {session.client_id &&
                          clientNameById.get(session.client_id) && (
                            <p className="mt-0.5 flex items-center gap-1 truncate text-[10px] leading-tight text-muted/60">
                              <Users size={9} className="shrink-0" />
                              {clientNameById.get(session.client_id)}
                            </p>
                          )}
                        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] leading-tight text-muted/70">
                          <span>
                            {formatSessionTime(session.updated_at, t, formatDate)}
                          </span>
                          {session.share_token ? (
                            <span className="inline-flex items-center gap-1 text-primary">
                              <Share2 size={10} aria-hidden="true" />
                              {t('sidebar.shared')}
                            </span>
                          ) : null}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            shareSession(session.id);
                          }}
                          className="w-5 h-5 rounded flex items-center justify-center opacity-40 group-hover:opacity-60 hover:!opacity-100 text-muted hover:text-primary hover:bg-primary/10 transition-all duration-200 cursor-pointer disabled:cursor-wait disabled:opacity-40"
                          aria-label={t('sharePoster.title')}
                          title={t('sharePoster.title')}
                        >
                          <Share2 size={11} />
                        </button>
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            startEditingSession(session.id, session.title);
                          }}
                          className="w-5 h-5 rounded flex items-center justify-center opacity-40 group-hover:opacity-60 hover:!opacity-100 text-muted hover:text-primary hover:bg-primary/10 transition-all duration-200 cursor-pointer"
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
                          className="w-5 h-5 rounded flex items-center justify-center opacity-40 group-hover:opacity-60 hover:!opacity-100 text-muted hover:text-primary hover:bg-primary/10 transition-all duration-200 cursor-pointer"
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

        {/* 底部：用户区（余额+头像，Claude 式左下角用户入口）+ 紧凑工具行。 */}
        <div className="relative px-3 py-3 shrink-0">
          <div className="absolute top-0 left-4 right-4 h-px bg-gradient-to-r from-transparent via-hairline/40 to-transparent" />

          <div className="mb-2">
            <LanguageSwitcher compact collapseOnDesktop={collapsed} />
          </div>

          {/* 无框 ghost 工具行:底部工具是最低层级,不用边框和常亮高亮抢会话列表的注意力。 */}
          <div
            className={`grid grid-cols-5 gap-1 ${collapsed ? 'lg:grid-cols-1' : ''}`}
            role="group"
            aria-label={t('sidebar.shortcutsAndTheme')}
          >
            <Link
              href="/status"
              onClick={closeSidebar}
              className={`flex h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium text-muted transition-colors hover:bg-canvas/70 hover:text-ink ${collapsed ? 'lg:h-10 lg:w-10' : ''}`}
              aria-label={t('sidebar.viewStatus')}
              title={t('sidebar.viewStatus')}
            >
              <Activity
                size={14}
                strokeWidth={1.8}
                className={collapsed ? 'lg:size-[18px]' : ''}
              />
              <span className={collapsed ? 'lg:hidden' : ''}>
                {t('sidebar.status')}
              </span>
            </Link>
            <Link
              href="/announcements"
              onClick={closeSidebar}
              className={`flex h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium text-muted transition-colors hover:bg-canvas/70 hover:text-ink ${collapsed ? 'lg:h-10 lg:w-10' : ''}`}
              aria-label={t('sidebar.viewAnnouncements')}
              title={t('sidebar.viewAnnouncements')}
            >
              <Megaphone
                size={14}
                strokeWidth={1.8}
                aria-hidden="true"
                className={collapsed ? 'lg:size-[18px]' : ''}
              />
              <span className={collapsed ? 'lg:hidden' : ''}>
                {t('sidebar.announcements')}
              </span>
            </Link>
            <Link
              href="/issues"
              onClick={closeSidebar}
              className={`flex h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium text-muted transition-colors hover:bg-canvas/70 hover:text-ink ${collapsed ? 'lg:h-10 lg:w-10' : ''}`}
              aria-label={
                issueUnread > 0
                  ? t('sidebar.issuesUnread', { count: issueUnread })
                  : t('sidebar.issues')
              }
              title={
                issueUnread > 0
                  ? t('sidebar.issuesUnread', { count: issueUnread })
                  : t('sidebar.issues')
              }
            >
              <span className="relative inline-flex">
                <CircleDot
                  size={14}
                  strokeWidth={1.8}
                  className={collapsed ? 'lg:size-[18px]' : ''}
                />
                {issueUnread > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute -right-2.5 -top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-none text-on-primary ring-2 ring-canvas"
                  >
                    {issueUnread > 99 ? '99+' : issueUnread}
                  </span>
                )}
              </span>
              <span className={`whitespace-nowrap ${collapsed ? 'lg:hidden' : ''}`}>
                {t('sidebar.issues')}
              </span>
            </Link>
            <Link
              href="/acknowledgements"
              onClick={closeSidebar}
              className={`flex h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium text-muted transition-colors hover:bg-canvas/70 hover:text-ink ${collapsed ? 'lg:h-10 lg:w-10' : ''}`}
              aria-label={t('acknowledgements.title')}
              title={t('acknowledgements.title')}
            >
              <Heart
                size={14}
                strokeWidth={1.8}
                aria-hidden="true"
                className={collapsed ? 'lg:size-[18px]' : ''}
              />
              <span className={collapsed ? 'lg:hidden' : ''}>
                {t('acknowledgements.navigation')}
              </span>
            </Link>
            <button
              type="button"
              onClick={cycleThemeMode}
              className={`flex h-11 min-w-0 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium text-muted transition-all duration-200 hover:bg-canvas/70 hover:text-ink ${collapsed ? 'lg:h-10 lg:w-10' : ''}`}
              aria-label={t('sidebar.switchTheme', {
                theme: activeThemeLabel,
              })}
              title={t('sidebar.currentTheme', { theme: activeThemeLabel })}
            >
              <ActiveThemeIcon
                size={14}
                strokeWidth={1.8}
                className={collapsed ? 'lg:size-[18px]' : ''}
              />
              <span
                className={`max-w-full truncate leading-tight ${collapsed ? 'lg:hidden' : ''}`}
              >
                {activeThemeLabel}
              </span>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
