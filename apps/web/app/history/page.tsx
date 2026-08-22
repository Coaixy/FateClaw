'use client';

import { useEffect, useMemo, useReducer, useState } from 'react';
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MessageCircle,
  MessageSquareText,
  Pencil,
  Search,
  Share2,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { useChatSessions } from '@/features/chat/hooks/use-chat-sessions';
import { useClientProfiles } from '@/features/chat/hooks/use-client-profiles';
import { ChatSession } from '@/features/chat/api';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';

/** 历史页每页条数；与客户列表的分页粒度保持一致。 */
const HISTORY_PAGE_SIZE = 20;

type HistoryDateFilter = 'all' | 'today' | '7d' | '30d' | 'older';

const HISTORY_DATE_FILTERS: readonly { value: HistoryDateFilter; labelKey: string }[] = [
  { value: 'all', labelKey: 'sidebar.filters.all' },
  { value: 'today', labelKey: 'sidebar.filters.today' },
  { value: '7d', labelKey: 'sidebar.filters.sevenDays' },
  { value: '30d', labelKey: 'sidebar.filters.thirtyDays' },
  { value: 'older', labelKey: 'sidebar.filters.older' },
];

/**
 * 按更新时间判断会话是否落在所选日期筛选内。
 *
 * 与侧边栏同名逻辑保持一致的口径：today 为自然日起点，7d/30d 各回溯相应天数，
 * older 为 30 天前。抽到历史页时复制而非共享，避免为两处 UI 引入公共模块依赖。
 */
function matchDateFilter(updatedAt: string, filter: HistoryDateFilter, now: Date) {
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

/**
 * 会话时间的短格式展示：今天/昨天/N天前，更早则显示「月/日」。
 */
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

type RowActionState = {
  renamingSessionId: string;
  sharingSessionId: string;
};

type RowActionAction =
  | { type: 'setRenaming'; sessionId: string }
  | { type: 'setSharing'; sessionId: string };

function rowActionReducer(
  state: RowActionState,
  action: RowActionAction,
): RowActionState {
  switch (action.type) {
    case 'setRenaming':
      // 同一时间只允许一行处于操作中，再次点击同一行则取消该状态。
      return {
        ...state,
        renamingSessionId:
          state.renamingSessionId === action.sessionId ? '' : action.sessionId,
        sharingSessionId:
          state.sharingSessionId === action.sessionId ? '' : state.sharingSessionId,
      };
    case 'setSharing':
      return {
        ...state,
        sharingSessionId:
          state.sharingSessionId === action.sessionId ? '' : action.sessionId,
        renamingSessionId:
          state.renamingSessionId === action.sessionId ? '' : state.renamingSessionId,
      };
  }
}

/**
 * 对话历史页：完整查看全部站内 AI Chat 会话（侧栏仅展示最近 10 条的预览）。
 *
 * 数据直接来自全局 ChatSessionsProvider（后端单次最多返回 500 条），
 * 不在页面里重复请求；搜索、日期筛选与分页都只作用于展示层。
 *
 * 页面组件只负责渲染 AppShell；用到 useChatSessions 的逻辑必须放在内层
 * HistoryContent 里，因为 Provider 由 AppShell 在 children 外侧提供，
 * 页面组件自身运行在 Provider 之外（与 AiChatWorkspace 的分层一致）。
 */
export default function HistoryPage() {
  return (
    <AppShell>
      <HistoryContent />
    </AppShell>
  );
}

function HistoryContent() {
  const { formatDate, formatNumber, t } = useI18n();
  const { toast } = useToast();

  const {
    sessions,
    setSelectedSession,
    renameSession,
    archiveSession,
    shareSession,
    loading: sessionsLoading,
  } = useChatSessions();

  // 行内改名编辑态：editingId 非空表示该行正在编辑标题。
  const [editingId, setEditingId] = useState('');
  const [editingTitle, setEditingTitle] = useState('');
  const [rowAction, dispatchRowAction] = useReducer(rowActionReducer, {
    renamingSessionId: '',
    sharingSessionId: '',
  });

  // 列表查询态：搜索词、日期筛选、页码。筛选变化时重置页码。
  const [query, dispatchQuery] = useReducer(
    (
      state: { search: string; dateFilter: HistoryDateFilter; page: number },
      action:
        | { type: 'search'; value: string }
        | { type: 'dateFilter'; value: HistoryDateFilter }
        | { type: 'page'; value: number },
    ) => {
      switch (action.type) {
        case 'search':
          return { ...state, search: action.value, page: 1 };
        case 'dateFilter':
          return { ...state, dateFilter: action.value, page: 1 };
        case 'page':
          return { ...state, page: action.value };
      }
    },
    { search: '', dateFilter: 'all', page: 1 },
  );
  const { search, dateFilter, page } = query;

  // 与侧栏一致：静默拉取客户档案，把会话上的 client_id join 成客户名展示；失败不打扰用户。
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
    if (!hasSessionWithClient) {
      return;
    }
    void loadClientProfiles().catch(() => {});
  }, [hasSessionWithClient, loadClientProfiles]);

  // 搜索 + 日期筛选 → 分页，三层都只作用于展示层，不改动 Provider 里的原始数组。
  // now 在 useMemo 内取值，避免每次渲染生成新实例导致缓存失效。
  const normalizedSearch = search.trim().toLowerCase();
  const filteredSessions = useMemo(() => {
    const now = new Date();
    const byDate = sessions.filter((session) =>
      matchDateFilter(session.updated_at, dateFilter, now),
    );
    if (!normalizedSearch) {
      return byDate;
    }
    return byDate.filter((session) =>
      session.title.toLowerCase().includes(normalizedSearch),
    );
  }, [sessions, dateFilter, normalizedSearch]);

  const totalPages = Math.max(1, Math.ceil(filteredSessions.length / HISTORY_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedSessions = filteredSessions.slice(
    (currentPage - 1) * HISTORY_PAGE_SIZE,
    currentPage * HISTORY_PAGE_SIZE,
  );

  const showSkeleton = sessions.length === 0 && sessionsLoading;

  const openSession = (sessionId: string) => {
    setSelectedSession(sessionId);
  };

  const startEditing = (session: ChatSession) => {
    setEditingId(session.id);
    setEditingTitle(session.title);
    dispatchRowAction({ type: 'setRenaming', sessionId: '' });
  };

  const resetEditing = () => {
    setEditingId('');
    setEditingTitle('');
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
      resetEditing();
      return;
    }

    if (normalizedTitle === currentSession.title) {
      resetEditing();
      return;
    }

    dispatchRowAction({ type: 'setRenaming', sessionId });
    try {
      await renameSession(sessionId, normalizedTitle);
      toast('success', t('sidebar.titleUpdated'));
      resetEditing();
    } catch (error) {
      dispatchRowAction({ type: 'setRenaming', sessionId: '' });
      toast(
        'error',
        error instanceof Error ? error.message : t('sidebar.titleUpdateFailed'),
      );
    }
  };

  const copySessionShareLink = async (sessionId: string) => {
    if (rowAction.sharingSessionId) return;
    dispatchRowAction({ type: 'setSharing', sessionId });
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
      dispatchRowAction({ type: 'setSharing', sessionId: '' });
    }
  };

  const handleArchive = async (sessionId: string) => {
    try {
      await archiveSession(sessionId);
      toast('success', t('sidebar.archivedToast'));
    } catch (error) {
      toast(
        'error',
        error instanceof Error ? error.message : t('sidebar.archiveFailed'),
      );
    }
  };

  const activeDateFilterLabel = t(
    HISTORY_DATE_FILTERS.find((item) => item.value === dateFilter)?.labelKey ??
      'sidebar.filters.all',
  );

  // 空态文案区分「真的没有对话」「筛选无结果」两种情况，复用侧栏文案。
  const emptyMessage = normalizedSearch
    ? dateFilter === 'all'
      ? t('sidebar.noMatchedSearch', { query: search.trim() })
      : t('sidebar.noMatchedSearchInFilter', {
          query: search.trim(),
          filter: activeDateFilterLabel,
        })
    : dateFilter === 'all'
      ? t('sidebar.noSessions')
      : t('sidebar.noSessionsInFilter', { filter: activeDateFilterLabel });

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <header>
        <h1 className="text-2xl font-bold tracking-tight">{t('history.title')}</h1>
        <p className="mt-1 text-sm text-muted">{t('history.description')}</p>
      </header>

        {/* 搜索 + 日期筛选 */}
        <section className="space-y-3">
          <div className="relative">
            <Search
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
            />
            <input
              type="search"
              value={search}
              onChange={(event) =>
                dispatchQuery({ type: 'search', value: event.target.value })
              }
              placeholder={t('sidebar.searchPlaceholder')}
              aria-label={t('sidebar.searchPlaceholder')}
              className="w-full h-10 pl-9 pr-3 rounded-xl border border-hairline bg-surface-card text-[13px] placeholder:text-muted focus:border-primary focus:outline-none transition-all"
            />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {HISTORY_DATE_FILTERS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() =>
                  dispatchQuery({ type: 'dateFilter', value: item.value })
                }
                className={`h-8 rounded-lg border px-3 text-[12px] font-medium transition-all ${
                  dateFilter === item.value
                    ? 'border-primary/30 bg-primary/12 text-primary'
                    : 'border-hairline bg-surface-card text-muted hover:border-primary/25 hover:text-ink'
                }`}
                aria-pressed={dateFilter === item.value}
              >
                {t(item.labelKey)}
              </button>
            ))}
          </div>

          {/* 会话列表（AppShell 已保证登录态，无需单独处理未登录分支） */}
          {showSkeleton ? (
            <HistorySkeleton />
          ) : filteredSessions.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-hairline py-14 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-canvas/70">
                <MessageCircle size={18} className="text-muted/40" />
              </div>
              <p className="text-[13px] text-muted">{emptyMessage}</p>
            </div>
          ) : (
            <>
              <div className="space-y-2.5">
                {pagedSessions.map((session) => {
                  const isEditing = session.id === editingId;
                  const isRenaming = session.id === rowAction.renamingSessionId;
                  const isSharing = session.id === rowAction.sharingSessionId;

                  if (isEditing) {
                    // 编辑态整行替换成输入框容器，避免按钮冒泡误触会话跳转。
                    return (
                      <div
                        key={session.id}
                        className="rounded-xl border border-primary/40 bg-primary/6 p-3"
                      >
                        <input
                          type="text"
                          value={editingTitle}
                          autoFocus
                          maxLength={80}
                          onChange={(event) => setEditingTitle(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void saveSessionTitle(session.id);
                            }
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              resetEditing();
                            }
                          }}
                          className="w-full h-9 rounded-lg border border-hairline bg-canvas px-3 text-[13px] text-ink placeholder:text-muted focus:border-primary focus:ring-1 focus:ring-primary/20 focus:outline-none transition-all"
                          aria-label={t('sidebar.editTitle')}
                        />
                        <div className="mt-2 flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => void saveSessionTitle(session.id)}
                            disabled={isRenaming}
                            className="inline-flex h-8 items-center gap-1 rounded-lg bg-primary/12 px-3 text-[12px] font-medium text-primary transition-colors hover:bg-primary/18 disabled:cursor-wait disabled:opacity-60"
                          >
                            {isRenaming ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : null}
                            {isRenaming ? t('common.saving') : t('common.save')}
                          </button>
                          <button
                            type="button"
                            onClick={resetEditing}
                            disabled={isRenaming}
                            className="inline-flex h-8 items-center rounded-lg px-3 text-[12px] font-medium text-muted transition-colors hover:bg-canvas hover:text-ink disabled:opacity-50"
                          >
                            {t('common.cancel')}
                          </button>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={session.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => openSession(session.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          openSession(session.id);
                        }
                      }}
                      className="group flex w-full cursor-pointer items-start gap-3 rounded-xl border border-hairline bg-surface-raised px-4 py-3 text-left transition-all duration-200 hover:border-primary/25 hover:shadow-sm"
                    >
                      <div className="mt-0.5 shrink-0">
                        <MessageCircle
                          size={16}
                          strokeWidth={1.8}
                          className="text-muted/50"
                          aria-hidden="true"
                        />
                      </div>

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] font-medium leading-snug text-ink">
                          {session.title}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted/75">
                          <span>
                            {formatSessionTime(session.updated_at, t, formatDate)}
                          </span>
                          {session.client_id && clientNameById.get(session.client_id) && (
                            <span className="inline-flex items-center gap-1 truncate">
                              <MessageSquareText size={10} className="shrink-0" />
                              {clientNameById.get(session.client_id)}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* 行级操作：分享 / 改名 / 归档。 */}
                      <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void copySessionShareLink(session.id);
                          }}
                          disabled={Boolean(rowAction.sharingSessionId)}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-primary/10 hover:text-primary disabled:cursor-wait disabled:opacity-40"
                          aria-label={t('sidebar.copyShareLink')}
                          title={t('sidebar.copyShareLink')}
                        >
                          {isSharing ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Share2 size={14} />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            startEditing(session);
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-primary/10 hover:text-primary"
                          aria-label={t('sidebar.modifyTitle')}
                          title={t('sidebar.modifyTitle')}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleArchive(session.id);
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-error/10 hover:text-error"
                          aria-label={t('sidebar.archiveChat')}
                          title={t('sidebar.archiveChat')}
                        >
                          <Archive size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* 分页条 */}
              {filteredSessions.length > HISTORY_PAGE_SIZE && (
                <div className="flex flex-col items-center justify-between gap-2 rounded-2xl border border-hairline/60 bg-surface-card/60 px-3 py-2 sm:flex-row">
                  <span className="text-[11px] text-muted tabular-nums">
                    {formatNumber(
                      (currentPage - 1) * HISTORY_PAGE_SIZE + 1,
                    )}
                    –{formatNumber(Math.min(currentPage * HISTORY_PAGE_SIZE, filteredSessions.length))}
                    {' / '}
                    {formatNumber(filteredSessions.length)}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        dispatchQuery({ type: 'page', value: Math.max(1, currentPage - 1) })
                      }
                      disabled={currentPage <= 1}
                      className="inline-flex h-8 items-center gap-1 rounded-full px-3 text-[11px] text-muted transition-all hover:bg-surface-cream-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      <ChevronLeft size={13} />
                      {t('sidebar.previousPage')}
                    </button>
                    <span className="inline-flex h-8 min-w-14 items-center justify-center rounded-full bg-surface-cream-strong px-2 text-[11px] tabular-nums text-ink">
                      {formatNumber(currentPage)} / {formatNumber(totalPages)}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        dispatchQuery({
                          type: 'page',
                          value: Math.min(totalPages, currentPage + 1),
                        })
                      }
                      disabled={currentPage >= totalPages}
                      className="inline-flex h-8 items-center gap-1 rounded-full px-3 text-[11px] text-muted transition-all hover:bg-surface-cream-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      {t('sidebar.nextPage')}
                      <ChevronRight size={13} />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
    </div>
  );
}

function HistorySkeleton() {
  return (
    <div className="space-y-2.5" role="status" aria-label="loading">
      {[0, 1, 2, 3, 4].map((index) => (
        <div
          key={index}
          className="flex items-start gap-3 rounded-xl border border-hairline bg-surface-raised px-4 py-3"
        >
          <div className="h-6 w-6 shrink-0 animate-pulse rounded-lg bg-muted/10" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3.5 w-48 animate-pulse rounded-full bg-muted/12" />
            <div className="h-2.5 w-20 animate-pulse rounded-full bg-muted/10" />
          </div>
        </div>
      ))}
    </div>
  );
}
