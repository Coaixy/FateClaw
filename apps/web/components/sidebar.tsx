'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Archive,
  LayoutGrid,
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
  Check,
  SquarePen,
  Sun,
  ExternalLink,
  Send,
  Users,
} from 'lucide-react';
import { useReducer, useState, useEffect, useMemo } from 'react';
import { isAiChatPath, useChatSessions } from '@/features/chat/hooks/use-chat-sessions';
import { useClientProfiles } from '@/features/chat/hooks/use-client-profiles';
import { useAuth } from '@/features/auth/hooks/use-auth';
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

// 侧栏会话列表的临时交互状态：搜索词、日期筛选、行内改名（编辑中的会话与标题、
// 改名提交中）、分享提交中、展开的会话面板是否打开。这些都属于「会话列表视图态」，且在登录态
// 变化时需要整体复位，因此聚合到一个 reducer 里统一管理，用单次 dispatch 表达整组变更。
type SessionListState = {
  search: string;
  dateFilter: SessionDateFilter;
  editingSessionId: string;
  editingTitle: string;
  renamingSessionId: string;
  sharingSessionId: string;
  sessionsPanelOpen: boolean;
};

const INITIAL_SESSION_LIST_STATE: SessionListState = {
  search: '',
  dateFilter: 'all',
  editingSessionId: '',
  editingTitle: '',
  renamingSessionId: '',
  sharingSessionId: '',
  sessionsPanelOpen: false,
};

type SessionListAction =
  | { type: 'reset' } // 登录态变化后整体复位
  | { type: 'closePanel' } // 收起展开的会话面板
  | { type: 'clearEditing' } // 退出行内改名
  | { type: 'startEditing'; sessionId: string; title: string }
  | { type: 'setEditingTitle'; title: string }
  | { type: 'setRenaming'; sessionId: string }
  | { type: 'setSharing'; sessionId: string };

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
    case 'setSharing':
      return { ...state, sharingSessionId: action.sessionId };
    default:
      return state;
  }
}

export function Sidebar({ onLogout }: { onLogout: () => void }) {
  const { formatDate, formatNumber, locale, t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const { toast } = useToast();
  const { loading: authLoading } = useAuth();
  const [open, setOpen] = useState(false);
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
    sharingSessionId,
    sessionsPanelOpen,
  } = sessionList;
  const [contactOpen, setContactOpen] = useState(false);
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
    if (!contactOpen && !sessionsPanelOpen) {
      return;
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (contactOpen) {
          setContactOpen(false);
          return;
        }
        dispatchSessionList({ type: 'closePanel' });
      }
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [contactOpen, sessionsPanelOpen]);

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

  const copySessionShareLink = async (sessionId: string) => {
    if (sharingSessionId) return;
    dispatchSessionList({ type: 'setSharing', sessionId });
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
      dispatchSessionList({ type: 'setSharing', sessionId: '' });
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
      {/* 侧栏专用深底色(sidebar token,比画布深约 6%):与主画布形成肉眼可见的双色分层,
          这是整页结构层次的地基。 */}
      <aside
        className={`fixed top-0 left-0 h-full w-[260px] bg-sidebar border-r border-hairline flex flex-col z-50 transition-transform duration-300 ease-out lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >

        {/* Logo 区域 */}
        <div className="relative flex items-center justify-between px-5 h-16 shrink-0">
          <Logo />
          <button
            onClick={closeSidebar}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted hover:text-ink hover:bg-canvas/70 transition-all duration-200 cursor-pointer lg:hidden"
            aria-label={t('sidebar.closeMenu')}
          >
            <X size={16} />
          </button>
        </div>

        {/* 主操作:新建对话(对齐 Claude 侧栏结构,任何页面一步发起);工作台降为普通导航行。 */}
        <div className="relative space-y-1 px-3 shrink-0">
          <button
            type="button"
            onClick={() => {
              closeSidebar();
              // 清空选中会话 → ChatSessionsProvider 自动跳转 /ai-chat 开新对话
              setSelectedSession('');
            }}
            className="flex h-10 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-3 text-[13px] font-semibold text-primary transition-colors duration-200 hover:bg-primary/10"
            aria-label={t('hub.newChat')}
          >
            <SquarePen size={15} strokeWidth={2} className="shrink-0" />
            <span className="truncate">{t('hub.newChat')}</span>
          </button>
          <Link
            href="/"
            onClick={closeSidebar}
            className="flex h-10 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-3 text-[13px] font-medium text-muted transition-colors duration-200 hover:bg-canvas/70 hover:text-ink"
            aria-label={t('sidebar.workspace')}
          >
            <LayoutGrid size={15} strokeWidth={1.8} className="shrink-0" />
            <span className="truncate">{t('sidebar.workspace')}</span>
          </Link>
        </div>

        {/* 对话历史列表:节标签让列表区有明确的分组起点(对齐 Claude 侧栏的 Recents)。 */}
        <div className="relative flex-1 min-h-0 flex flex-col mt-5">
          <p className="flex shrink-0 items-center gap-1.5 px-5 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted/60">
            <span className="h-3 w-[2.5px] rounded-full bg-primary/70" aria-hidden="true" />
            {t('hub.recentChats')}
          </p>
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
              <div className="space-y-1">
                {sidebarPreviewSessions.map((session) => {
                  const active = session.id === selectedSession && isAiChatPath(pathname);
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
                      className={`group w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors duration-200 cursor-pointer ${
                        active
                          ? 'bg-primary/10 text-ink'
                          : 'text-muted hover:text-ink hover:bg-canvas/70'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-[13px] font-medium leading-tight">
                          {session.title}
                        </p>
                        {session.client_id &&
                          clientNameById.get(session.client_id) && (
                            <p className="mt-0.5 flex items-center gap-1 truncate text-[10px] leading-tight text-muted/60">
                              <Users size={9} className="shrink-0" />
                              {clientNameById.get(session.client_id)}
                            </p>
                          )}
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

        {/* 底部：用户区（余额+头像，Claude 式左下角用户入口）+ 紧凑工具行。 */}
        <div className="relative px-3 py-3 shrink-0">
          <div className="absolute top-0 left-4 right-4 h-px bg-gradient-to-r from-transparent via-hairline/40 to-transparent" />

          <div className="mb-2">
            <LanguageSwitcher compact />
          </div>

          {/* 无框 ghost 工具行:底部工具是最低层级,不用边框和常亮高亮抢会话列表的注意力。 */}
          <div
            className="grid grid-cols-2 gap-1"
            role="group"
            aria-label={t('sidebar.shortcutsAndTheme')}
          >
            <button
              type="button"
              onClick={() => {
                setContactQrType(locale === 'zh-CN' ? 'wechat' : 'telegram');
                setContactOpen(true);
              }}
              className="group flex h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium text-muted transition-all duration-200 hover:bg-canvas/70 hover:text-ink"
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
              className="flex h-11 min-w-0 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium text-muted transition-all duration-200 hover:bg-canvas/70 hover:text-ink"
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
            className="w-full max-w-[320px] rounded-2xl border border-hairline bg-surface-raised p-4 shadow-2xl"
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
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-all duration-200 hover:bg-canvas/70 hover:text-ink"
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
