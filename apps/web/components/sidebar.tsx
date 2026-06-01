'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  Info,
  Loader2,
  LogIn,
  MessageCircle,
  Share2,
  Trash2,
  Menu,
  X,
  SquarePen,
  Search,
  Pencil,
  Check,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { useChatSessions } from '@/features/chat/hooks/use-chat-sessions';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { buildLoginHref } from '@/lib/auth-redirect';
import { useToast } from '@/lib/use-toast';
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
            命枢
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

  const {
    sessions,
    selectedSession,
    setSelectedSession,
    renameSession,
    deleteSession,
    shareSession,
    chatAvailable,
    loading: sessionsLoading,
  } = useChatSessions();

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    // 登录态变化后复位筛选和编辑态，避免用户误以为列表丢失。
    setSearch('');
    setDateFilter('all');
    setEditingSessionId('');
    setEditingTitle('');
    setRenamingSessionId('');
    setSharingSessionId('');
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

  const goNewChat = () => {
    // 手机端在当前页内切会话/新建对话时，pathname 不会变化，必须主动收起抽屉。
    closeSidebar();
    // 统一走 ChatSessionsProvider 的路由同步逻辑，避免这里再补一次 router.push
    // 把带参数的目标地址覆盖成裸 /ai-chat。
    setSelectedSession('');
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

        {/* 新建对话按钮 */}
        <div className="relative px-3 shrink-0">
          <button
            onClick={goNewChat}
            className="w-full flex items-center gap-2.5 px-3.5 h-11 rounded-xl border border-hairline/60 bg-surface-card/50 text-ink text-[13px] font-medium hover:border-primary/40 hover:bg-primary/10 transition-all duration-200 cursor-pointer"
            aria-label="新建对话"
          >
            <SquarePen size={15} className="text-primary" />
            新建对话
          </button>
        </div>

        {/* 对话历史列表 */}
        <div className="relative flex-1 min-h-0 flex flex-col mt-4">
          <div className="px-5 pb-2 shrink-0 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted/70">
                最近对话
              </span>
              {sessions.length > 0 && (
                <span className="text-[10px] text-muted/55">
                  {filteredSessions.length}/{sessions.length}
                </span>
              )}
            </div>
            {sessions.length > 0 && (
              <div className="space-y-2">
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
                    className="w-full h-9 rounded-xl border border-hairline bg-canvas pl-9 pr-9 text-[12px] text-ink placeholder:text-muted/75 focus:border-primary focus:ring-1 focus:ring-primary/20 focus:outline-none transition-all"
                  />
                  {search && (
                    <button
                      onClick={() => setSearch('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-md flex items-center justify-center text-muted/70 hover:text-ink hover:bg-surface-card transition-all duration-200 cursor-pointer"
                      aria-label="清空搜索"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>

                <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
                  {SESSION_DATE_FILTERS.map((item) => (
                    <button
                      key={item.value}
                      onClick={() => setDateFilter(item.value)}
                      className={`shrink-0 whitespace-nowrap h-7 px-2.5 rounded-lg text-[11px] font-medium transition-all duration-200 cursor-pointer ${
                        dateFilter === item.value
                          ? 'bg-primary/12 text-primary border border-primary/20'
                          : 'bg-surface-card text-muted border border-hairline/60 hover:text-ink hover:border-primary/20'
                      }`}
                      aria-pressed={dateFilter === item.value}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
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
                {filteredSessions.map((session) => {
                  const active = session.id === selectedSession && pathname === '/ai-chat';
                  const isEditing = session.id === editingSessionId;
                  const isRenaming = session.id === renamingSessionId;
                  const isSharing = session.id === sharingSessionId;
                  const openSession = () => {
                    // 统一走 ChatSessionsProvider 的路由同步逻辑，确保跳转始终携带 sid。
                    // 手机端切换会话不会触发 pathname 变化，这里仍然要先主动收起侧边栏。
                    closeSidebar();
                    setSelectedSession(session.id);
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
                            void deleteSession(session.id).catch((error) => {
                              toast(
                                'error',
                                error instanceof Error
                                  ? error.message
                                  : '删除对话失败，请稍后重试',
                              );
                            });
                          }}
                          className="w-5 h-5 rounded flex items-center justify-center opacity-60 lg:opacity-0 lg:group-hover:opacity-60 hover:!opacity-100 text-muted hover:text-error hover:bg-error/10 transition-all duration-200 cursor-pointer"
                          aria-label="删除对话"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* 底部：放固定信息入口，主题切换保留在个人设置页里。 */}
        <div className="relative px-3 py-3 shrink-0">
          <div className="absolute top-0 left-4 right-4 h-px bg-gradient-to-r from-transparent via-hairline/40 to-transparent" />

          <div className="space-y-1">
            <Link
              href="/status"
              onClick={closeSidebar}
              className={`group flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all duration-200 ${
                pathname === '/status'
                  ? 'bg-primary/10 text-ink'
                  : 'text-muted hover:text-ink hover:bg-surface-card'
              }`}
              aria-label="查看平台状态"
            >
              <div className="w-8 h-8 rounded-lg bg-surface-card flex items-center justify-center group-hover:bg-primary/10 group-hover:text-primary transition-all duration-200">
                <Activity size={16} strokeWidth={1.8} />
              </div>
              <div className="min-w-0">
                <span className="block leading-tight">状态</span>
                <span className="mt-0.5 block truncate text-[10px] font-normal text-muted/65">
                  平台运行与 Token 趋势
                </span>
              </div>
            </Link>

            <Link
              href="/about"
              onClick={closeSidebar}
              className={`group flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all duration-200 ${
                pathname === '/about'
                  ? 'bg-primary/10 text-ink'
                  : 'text-muted hover:text-ink hover:bg-surface-card'
              }`}
              aria-label="查看关于我们"
            >
              <div className="w-8 h-8 rounded-lg bg-surface-card flex items-center justify-center group-hover:bg-primary/10 group-hover:text-primary transition-all duration-200">
                <Info size={16} strokeWidth={1.8} />
              </div>
              <div className="min-w-0">
                <span className="block leading-tight">关于我们</span>
                <span className="mt-0.5 block truncate text-[10px] font-normal text-muted/65">
                  传统文化与公益初心
                </span>
              </div>
            </Link>
          </div>
        </div>
      </aside>
    </>
  );
}
