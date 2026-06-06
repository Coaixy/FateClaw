'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  Archive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Info,
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
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { useChatSessions } from '@/features/chat/hooks/use-chat-sessions';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { buildLoginHref } from '@/lib/auth-redirect';
import { useToast } from '@/lib/use-toast';
import { ThemeMode, useTheme } from '@/lib/use-theme';
import { TopBar } from './top-bar';

function formatSessionTime(ts: string) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days}天前`;
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

type SessionDateFilter = 'all' | 'today' | '7d' | '30d' | 'older';

const SESSION_DATE_FILTERS: readonly {
  value: SessionDateFilter;
  label: string;
}[] = [
  { value: 'all', label: '全部' },
  { value: 'today', label: '今天' },
  { value: '7d', label: '近7天' },
  { value: '30d', label: '近30天' },
  { value: 'older', label: '更早' },
];
const SIDEBAR_SESSION_PREVIEW_LIMIT = 10;
const SESSION_PANEL_PAGE_SIZE = 6;

const SIDEBAR_THEME_OPTIONS: readonly {
  mode: ThemeMode;
  label: string;
  icon: typeof Monitor;
}[] = [
  { mode: 'system', label: '跟随', icon: Monitor },
  { mode: 'light', label: '浅色', icon: Sun },
  { mode: 'dark', label: '深色', icon: Moon },
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
  const rows = ['w-28', 'w-36', 'w-24', 'w-32', 'w-28'];

  return (
    <div
      className="space-y-1.5 px-1 py-1"
      role="status"
      aria-label="正在加载对话记录"
    >
      <span className="sr-only">正在加载对话记录</span>
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
            守义AI
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
  const [contactQrType, setContactQrType] = useState<'wechat' | 'qq'>(
    'wechat',
  );
  const { mode: themeMode, setMode: setThemeMode } = useTheme();
  const activeThemeOption =
    SIDEBAR_THEME_OPTIONS.find((item) => item.mode === themeMode) ??
    SIDEBAR_THEME_OPTIONS[0];
  const ActiveThemeIcon = activeThemeOption.icon;
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
    SESSION_DATE_FILTERS.find((item) => item.value === dateFilter)?.label ??
    '全部';
  const emptyStateMessage = normalizedSearch
    ? dateFilter === 'all'
      ? `没有匹配“${search.trim()}”的对话`
      : `没有匹配“${search.trim()}”且属于${activeDateFilterLabel}的对话`
    : dateFilter === 'all'
      ? '暂无对话'
      : `没有属于${activeDateFilterLabel}的对话`;
  const showSessionSkeleton =
    sessions.length === 0 && (authLoading || sessionsLoading);
  const contactQr =
    contactQrType === 'wechat'
      ? {
          title: '名誉站长',
          subtitle: '微信联系',
          src: '/contact/honorary-stationmaster-wechat.jpg',
          alt: '名誉站长微信二维码',
          helper: '扫码添加微信',
        }
      : {
          title: '守义AI内测群',
          subtitle: 'QQ群号：2163031185',
          src: '/contact/shouyi-ai-qq-group.jpg',
          alt: '守义AI内测QQ群二维码',
          helper: '扫码加入QQ群',
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
      toast('success', '分享链接已复制');
    } catch (error) {
      toast(
        'error',
        error instanceof Error ? error.message : '生成分享链接失败，请稍后重试',
      );
    } finally {
      setSharingSessionId('');
    }
  };

  const saveSessionTitle = async (sessionId: string) => {
    const normalizedTitle = editingTitle.trim();
    if (!normalizedTitle) {
      toast('error', '标题不能为空');
      return;
    }

    const currentSession = sessions.find((session) => session.id === sessionId);
    if (!currentSession) {
      toast('error', '会话不存在或已被删除');
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
      toast('success', '标题已更新');
      resetEditingState();
    } catch (error) {
      setRenamingSessionId('');
      toast(
        'error',
        error instanceof Error ? error.message : '更新标题失败，请稍后重试',
      );
    }
  };

  return (
    <>
      {/* Mobile top bar：汉堡 + 页名 + TopBar(compact) */}
      <header className="fixed top-0 left-0 right-0 h-14 z-40 lg:hidden">
        <div className="absolute inset-0 bg-canvas/85 backdrop-blur-xl" />
        <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-hairline/60 to-transparent" />

        <div className="relative h-full flex items-center justify-between px-3 gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <button
              onClick={() => setOpen((value) => !value)}
              className="w-9 h-9 rounded-xl flex items-center justify-center text-ink hover:bg-surface-card active:scale-95 transition-all duration-200 cursor-pointer shrink-0"
              aria-label={open ? '收起菜单' : '打开菜单'}
              aria-expanded={open}
            >
              {open ? <X size={18} strokeWidth={1.8} /> : <Menu size={18} strokeWidth={1.8} />}
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
            aria-label="关闭菜单"
          >
            <X size={16} />
          </button>
        </div>

        {/* 新建对话和最近对话入口 */}
        <div className="relative px-3 shrink-0">
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => setSessionsPanelOpen((value) => !value)}
              className={`flex h-11 min-w-0 items-center justify-between gap-1.5 rounded-xl border px-2.5 text-left transition-all duration-200 ${
                sessionsPanelOpen || normalizedSearch || dateFilter !== 'all'
                  ? 'border-primary/25 bg-primary/10 text-ink'
                  : 'border-hairline/60 bg-surface-card/60 text-muted hover:border-primary/25 hover:text-ink'
              }`}
              aria-label="打开最近对话面板"
              aria-expanded={sessionsPanelOpen}
              aria-haspopup="dialog"
            >
              <div className="min-w-0">
                <span className="block truncate text-[11px] font-semibold leading-tight text-ink">
                  最近对话
                </span>
                <span className="mt-0.5 block truncate text-[10px] leading-none text-muted">
                  {filteredSessions.length}/{sessions.length} · {activeDateFilterLabel}
                  {normalizedSearch ? ' · 搜索中' : ''}
                </span>
              </div>
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
              className="flex h-11 min-w-0 cursor-pointer items-center justify-center gap-2 rounded-xl border border-hairline/60 bg-surface-card/50 px-2.5 text-[13px] font-medium text-ink transition-all duration-200 hover:border-primary/40 hover:bg-primary/10"
              aria-label="新建对话"
            >
              <SquarePen size={15} className="shrink-0 text-primary" />
              <span className="truncate">新建对话</span>
            </button>
          </div>

          {sessionsPanelOpen && (
            <div
              role="dialog"
              aria-label="未归档对话"
              className="absolute left-3 right-3 top-full z-30 mt-2 overflow-hidden rounded-2xl border border-hairline/70 bg-canvas shadow-2xl"
            >
              <div className="flex items-center justify-between gap-2 border-b border-hairline/50 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-[12px] font-semibold text-ink">
                    未归档对话
                  </p>
                  <p className="text-[10px] leading-tight text-muted">
                    共 {sessions.length.toLocaleString()} 个
                  </p>
                </div>
                <Link
                  href="/ai-chat/archive"
                  onClick={() => {
                    setSessionsPanelOpen(false);
                    closeSidebar();
                  }}
                  className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-hairline/60 bg-surface-card px-2 text-[11px] font-medium text-muted transition-all duration-200 hover:border-primary/25 hover:text-ink"
                  aria-label="查看归档对话"
                  title="归档"
                >
                  <Archive size={12} strokeWidth={1.8} />
                  归档
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
                    placeholder="搜索对话标题..."
                    className="h-9 w-full rounded-xl border border-hairline bg-canvas pl-9 pr-8 text-[12px] text-ink placeholder:text-muted/75 transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
                  />
                  {search && (
                    <button
                      type="button"
                      onClick={() => setSearch('')}
                      className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted/70 transition-all duration-200 hover:bg-surface-card hover:text-ink"
                      aria-label="清空搜索"
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
                      {item.label}
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
                      {chatAvailable ? '暂无对话' : '登录后查看对话记录'}
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
                              {formatSessionTime(session.updated_at)}
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
                    ? '0 / 0'
                    : `${currentSessionPanelPage} / ${sessionPanelPageCount}`}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      setSessionPanelPage((page) => Math.max(1, page - 1))
                    }
                    disabled={currentSessionPanelPage <= 1}
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-all duration-200 hover:bg-surface-card hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
                    aria-label="上一页"
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
                    aria-label="下一页"
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
                  {chatAvailable ? '暂无对话' : '登录后查看对话记录'}
                </p>
                {!chatAvailable && (
                  <button
                    type="button"
                    onClick={() => router.push(buildLoginHref())}
                    className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-hairline bg-surface-card px-3 text-[11px] font-medium text-ink transition-colors hover:border-primary/35 hover:bg-primary/10"
                  >
                    <LogIn size={12} className="text-primary" />
                    登录
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
                              aria-label="编辑对话标题"
                            />
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-[10px] text-muted/55 leading-tight">
                                {formatSessionTime(session.updated_at)}
                              </p>
                              <div className="flex items-center gap-1.5">
                                <button
                                  onClick={() => void saveSessionTitle(session.id)}
                                  disabled={isRenaming}
                                  className="h-7 px-2.5 rounded-lg flex items-center gap-1 text-[11px] font-medium bg-primary/12 text-primary hover:bg-primary/18 transition-all duration-200 cursor-pointer disabled:opacity-60 disabled:cursor-wait"
                                >
                                  <Check size={12} />
                                  {isRenaming ? '保存中...' : '保存'}
                                </button>
                                <button
                                  onClick={resetEditingState}
                                  disabled={isRenaming}
                                  className="h-7 px-2.5 rounded-lg text-[11px] font-medium text-muted hover:text-ink hover:bg-surface-card transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  取消
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
                          {formatSessionTime(session.updated_at)}
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
                          aria-label="复制分享链接"
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
                          aria-label="修改标题"
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void archiveSession(session.id)
                              .then(() => toast('success', '已归档'))
                              .catch((error) => {
                                toast(
                                  'error',
                                  error instanceof Error
                                    ? error.message
                                    : '归档对话失败，请稍后重试',
                                );
                              });
                          }}
                          className="w-5 h-5 rounded flex items-center justify-center opacity-60 lg:opacity-0 lg:group-hover:opacity-60 hover:!opacity-100 text-muted hover:text-primary hover:bg-primary/10 transition-all duration-200 cursor-pointer"
                          aria-label="归档对话"
                          title="归档对话"
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

          <div
            className="grid grid-cols-4 gap-1 rounded-xl border border-hairline/60 bg-surface-card/60 p-1"
            role="group"
            aria-label="侧栏快捷入口和主题切换"
          >
            <Link
              href="/status"
              onClick={closeSidebar}
              className={`group flex h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium transition-all duration-200 ${
                pathname === '/status'
                  ? 'bg-primary/10 text-ink'
                  : 'text-muted hover:text-ink hover:bg-surface-card'
              }`}
              aria-label="查看平台状态"
              title="状态"
            >
              <Activity
                size={14}
                strokeWidth={1.8}
                className="group-hover:text-primary"
              />
              <span className="max-w-full truncate leading-tight">状态</span>
            </Link>

            <Link
              href="/about"
              onClick={closeSidebar}
              className={`group flex h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium transition-all duration-200 ${
                pathname === '/about'
                  ? 'bg-primary/10 text-ink'
                  : 'text-muted hover:text-ink hover:bg-surface-card'
              }`}
              aria-label="查看关于我们"
              title="关于我们"
            >
              <Info
                size={14}
                strokeWidth={1.8}
                className="group-hover:text-primary"
              />
              <span className="max-w-full truncate leading-tight">关于</span>
            </Link>

            <button
              type="button"
              onClick={() => setContactOpen(true)}
              className="group flex h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] font-medium text-muted transition-all duration-200 hover:bg-surface-card hover:text-ink"
              aria-label="联系名誉站长"
              title="联系名誉站长"
            >
              <MessageCircle
                size={14}
                strokeWidth={1.8}
                className="group-hover:text-primary"
              />
              <span className="max-w-full truncate leading-tight">联系</span>
            </button>

            <button
              type="button"
              onClick={cycleThemeMode}
              className="flex h-11 min-w-0 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg bg-primary/12 text-[10px] font-medium text-primary shadow-sm transition-all duration-200 hover:bg-primary/18"
              aria-label={`切换主题，当前${activeThemeOption.label}`}
              title={`当前主题：${activeThemeOption.label}`}
            >
              <ActiveThemeIcon size={14} strokeWidth={1.8} />
              <span className="max-w-full truncate leading-tight">
                {activeThemeOption.label}
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
                aria-label="关闭联系方式"
              >
                <X size={16} />
              </button>
            </div>

            <div
              className="mt-4 grid grid-cols-2 gap-1 rounded-xl border border-hairline/60 bg-surface-card/60 p-1"
              role="group"
              aria-label="选择联系方式"
            >
              <button
                type="button"
                onClick={() => setContactQrType('wechat')}
                className={`h-8 rounded-lg text-[12px] font-medium transition-all duration-200 ${
                  contactQrType === 'wechat'
                    ? 'bg-primary/12 text-primary shadow-sm'
                    : 'text-muted hover:bg-canvas hover:text-ink'
                }`}
                aria-pressed={contactQrType === 'wechat'}
              >
                名誉站长
              </button>
              <button
                type="button"
                onClick={() => setContactQrType('qq')}
                className={`h-8 rounded-lg text-[12px] font-medium transition-all duration-200 ${
                  contactQrType === 'qq'
                    ? 'bg-primary/12 text-primary shadow-sm'
                    : 'text-muted hover:bg-canvas hover:text-ink'
                }`}
                aria-pressed={contactQrType === 'qq'}
              >
                QQ群
              </button>
            </div>

            <div className="mt-4 rounded-xl border border-hairline bg-white p-3">
              <img
                src={contactQr.src}
                alt={contactQr.alt}
                className="max-h-[58dvh] w-full rounded-lg object-contain"
              />
            </div>

            <p className="mt-3 text-center text-[12px] text-muted">
              {contactQr.helper}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
