'use client';

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MessageCircle,
  MessageSquareText,
  Pencil,
  RotateCcw,
  Search,
  Share2,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { useChatSessions } from '@/features/chat/hooks/use-chat-sessions';
import { useClientProfiles } from '@/features/chat/hooks/use-client-profiles';
import { chatSessionsApi, type ChatSession } from '@/features/chat/api';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';

/** 历史页每页条数；与客户列表的分页粒度保持一致。 */
const HISTORY_PAGE_SIZE = 20;

type HistoryDateFilter = 'all' | 'today' | '7d' | '30d' | 'older';
type HistoryView = 'active' | 'archived';

const HISTORY_DATE_FILTERS: readonly {
  value: HistoryDateFilter;
  labelKey: string;
}[] = [
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
function matchDateFilter(
  updatedAt: string,
  filter: HistoryDateFilter,
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

/**
 * Browse active and archived web conversations with search and date filters.
 *
 * Active sessions come from ChatSessionsProvider; archived sessions load on demand.
 * Each list contains at most 500 sessions; filtering and pagination are local.
 *
 * Session consumers stay inside HistoryContent because AppShell owns the provider.
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
    touchSession,
    loading: sessionsLoading,
  } = useChatSessions();

  // 行内改名编辑态：editingId 非空表示该行正在编辑标题。
  const [editingId, setEditingId] = useState('');
  const [editingTitle, setEditingTitle] = useState('');
  const [renamingSessionId, setRenamingSessionId] = useState('');

  // 列表查询态：搜索词、日期筛选、页码。筛选变化时重置页码。
  const [query, dispatchQuery] = useReducer(
    (
      state: {
        search: string;
        dateFilter: HistoryDateFilter;
        page: number;
        view: HistoryView;
      },
      action:
        | { type: 'search'; value: string }
        | { type: 'dateFilter'; value: HistoryDateFilter }
        | { type: 'view'; value: HistoryView }
        | { type: 'page'; value: number },
    ) => {
      switch (action.type) {
        case 'search':
          return { ...state, search: action.value, page: 1 };
        case 'dateFilter':
          return { ...state, dateFilter: action.value, page: 1 };
        case 'view':
          return { ...state, view: action.value, page: 1 };
        case 'page':
          return { ...state, page: action.value };
      }
    },
    { search: '', dateFilter: 'all', page: 1, view: 'active' },
  );
  const { search, dateFilter, page, view } = query;
  const [archiveState, setArchiveState] = useState<{
    sessions: ChatSession[];
    loading: boolean;
    error: string;
  }>({ sessions: [], loading: true, error: '' });
  const [archiveRetry, retryArchive] = useReducer(
    (attempt: number) => attempt + 1,
    0,
  );
  const [restoringSessionId, setRestoringSessionId] = useState('');
  const restoringSessionRef = useRef('');
  const visibleSessions =
    view === 'archived' ? archiveState.sessions : sessions;

  useEffect(() => {
    if (view !== 'archived') return;
    const controller = new AbortController();
    setArchiveState({ sessions: [], loading: true, error: '' });
    void chatSessionsApi.archived({ signal: controller.signal }).then(
      (list) => {
        if (!controller.signal.aborted) {
          setArchiveState({ sessions: list, loading: false, error: '' });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setArchiveState({
            sessions: [],
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : t('history.loadArchivedFailed'),
          });
        }
      },
    );
    return () => controller.abort();
  }, [archiveRetry, t, view]);

  // 与侧栏一致：静默拉取客户档案，把会话上的 client_id join 成客户名展示；失败不打扰用户。
  const { profiles: clientProfiles, loadProfiles: loadClientProfiles } =
    useClientProfiles(() => {});
  const hasSessionWithClient = useMemo(
    () => visibleSessions.some((session) => Boolean(session.client_id)),
    [visibleSessions],
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
    const byDate = visibleSessions.filter((session) =>
      matchDateFilter(
        session.deleted_at ?? session.updated_at,
        dateFilter,
        now,
      ),
    );
    if (!normalizedSearch) {
      return byDate;
    }
    return byDate.filter((session) =>
      session.title.toLowerCase().includes(normalizedSearch),
    );
  }, [visibleSessions, dateFilter, normalizedSearch]);

  const totalPages = Math.max(
    1,
    Math.ceil(filteredSessions.length / HISTORY_PAGE_SIZE),
  );
  const currentPage = Math.min(page, totalPages);
  const pagedSessions = filteredSessions.slice(
    (currentPage - 1) * HISTORY_PAGE_SIZE,
    currentPage * HISTORY_PAGE_SIZE,
  );

  const showSkeleton =
    view === 'archived'
      ? archiveState.loading
      : sessions.length === 0 && sessionsLoading;

  const openSession = (sessionId: string) => {
    setSelectedSession(sessionId);
  };

  const startEditing = (session: ChatSession) => {
    setEditingId(session.id);
    setEditingTitle(session.title);
    setRenamingSessionId('');
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

    setRenamingSessionId(sessionId);
    try {
      await renameSession(sessionId, normalizedTitle);
      toast('success', t('sidebar.titleUpdated'));
      resetEditing();
    } catch (error) {
      setRenamingSessionId('');
      toast(
        'error',
        error instanceof Error ? error.message : t('sidebar.titleUpdateFailed'),
      );
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

  const handleRestore = async (sessionId: string) => {
    if (restoringSessionRef.current) return;
    restoringSessionRef.current = sessionId;
    setRestoringSessionId(sessionId);
    try {
      const restored = await chatSessionsApi.restore(sessionId);
      touchSession(restored.id, restored);
      setArchiveState((previous) => ({
        ...previous,
        sessions: previous.sessions.filter(
          (session) => session.id !== sessionId,
        ),
      }));
      toast('success', t('history.restoredToast'));
    } catch (error) {
      toast(
        'error',
        error instanceof Error ? error.message : t('history.restoreFailed'),
      );
    } finally {
      restoringSessionRef.current = '';
      setRestoringSessionId('');
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
      ? t(view === 'archived' ? 'history.emptyArchived' : 'sidebar.noSessions')
      : t('sidebar.noSessionsInFilter', { filter: activeDateFilterLabel });

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <header>
        <h1 className="text-2xl font-bold tracking-tight">
          {t('history.title')}
        </h1>
        <p className="mt-1 text-sm text-muted">{t('history.description')}</p>
      </header>

      <div className="space-y-2">
        <div
          className="inline-flex gap-1 rounded-xl border border-hairline bg-surface-card p-1"
          role="group"
          aria-label={t('sidebar.status')}
        >
          {(['active', 'archived'] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={view === item}
              disabled={Boolean(restoringSessionId)}
              onClick={() => {
                resetEditing();
                dispatchQuery({ type: 'view', value: item });
              }}
              className={`inline-flex h-10 items-center gap-2 rounded-lg px-4 text-[13px] font-medium transition-colors disabled:cursor-wait disabled:opacity-60 ${
                view === item
                  ? 'bg-canvas text-ink shadow-sm'
                  : 'text-muted hover:text-ink'
              }`}
            >
              {item === 'archived' ? (
                <Archive size={14} aria-hidden="true" />
              ) : (
                <MessageCircle size={14} aria-hidden="true" />
              )}
              {t(item === 'archived' ? 'sidebar.archived' : 'history.active')}
            </button>
          ))}
        </div>
        {view === 'archived' && (
          <p className="text-[12px] text-muted">
            {t('history.archivedDescription')}
          </p>
        )}
      </div>

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
        ) : view === 'archived' && archiveState.error ? (
          <div
            role="alert"
            className="rounded-2xl border border-hairline bg-surface-card px-4 py-8 text-center"
          >
            <p className="text-[13px] text-error">{archiveState.error}</p>
            <button
              type="button"
              onClick={retryArchive}
              className="mt-3 inline-flex h-10 items-center gap-2 rounded-lg border border-hairline px-4 text-[13px] text-ink transition-colors hover:bg-canvas"
            >
              <RotateCcw size={14} aria-hidden="true" />
              {t('history.retry')}
            </button>
          </div>
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
                const isRenaming = session.id === renamingSessionId;
                const isArchived = Boolean(session.deleted_at);

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
                        onChange={(event) =>
                          setEditingTitle(event.target.value)
                        }
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
                    role={isArchived ? undefined : 'button'}
                    tabIndex={isArchived ? undefined : 0}
                    onClick={
                      isArchived ? undefined : () => openSession(session.id)
                    }
                    onKeyDown={
                      isArchived
                        ? undefined
                        : (event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              openSession(session.id);
                            }
                          }
                    }
                    className={`group flex w-full items-start gap-3 rounded-xl border border-hairline bg-surface-raised px-4 py-3 text-left transition-all duration-200 ${isArchived ? '' : 'cursor-pointer hover:border-primary/25 hover:shadow-sm'}`}
                  >
                    <div className="mt-0.5 shrink-0">
                      {isArchived ? (
                        <Archive
                          size={16}
                          strokeWidth={1.8}
                          className="text-muted/50"
                          aria-hidden="true"
                        />
                      ) : (
                        <MessageCircle
                          size={16}
                          strokeWidth={1.8}
                          className="text-muted/50"
                          aria-hidden="true"
                        />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium leading-snug text-ink">
                        {session.title}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted/75">
                        <span>
                          {isArchived
                            ? t('history.archivedAt', {
                                time: formatSessionTime(
                                  session.deleted_at ?? session.updated_at,
                                  t,
                                  formatDate,
                                ),
                              })
                            : formatSessionTime(
                                session.updated_at,
                                t,
                                formatDate,
                              )}
                        </span>
                        {session.share_token ? (
                          <span className="inline-flex items-center gap-1 text-primary">
                            <Share2 size={10} aria-hidden="true" />
                            {t('sidebar.shared')}
                          </span>
                        ) : null}
                        {session.client_id &&
                          clientNameById.get(session.client_id) && (
                            <span className="inline-flex items-center gap-1 truncate">
                              <MessageSquareText
                                size={10}
                                className="shrink-0"
                              />
                              {clientNameById.get(session.client_id)}
                            </span>
                          )}
                      </div>
                    </div>

                    {isArchived ? (
                      <button
                        type="button"
                        onClick={() => void handleRestore(session.id)}
                        disabled={Boolean(restoringSessionId)}
                        className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/10 px-3 text-[12px] font-medium text-primary transition-colors hover:bg-primary/15 disabled:cursor-wait disabled:opacity-60"
                      >
                        {restoringSessionId === session.id ? (
                          <Loader2
                            size={14}
                            className="animate-spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <RotateCcw size={14} aria-hidden="true" />
                        )}
                        {t(
                          restoringSessionId === session.id
                            ? 'history.restoring'
                            : 'history.restore',
                        )}
                      </button>
                    ) : (
                      <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            shareSession(session.id);
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-primary/10 hover:text-primary disabled:cursor-wait disabled:opacity-40"
                          aria-label={t('sharePoster.title')}
                          title={t('sharePoster.title')}
                        >
                          <Share2 size={14} />
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
                    )}
                  </div>
                );
              })}
            </div>

            {/* 分页条 */}
            {filteredSessions.length > HISTORY_PAGE_SIZE && (
              <div className="flex flex-col items-center justify-between gap-2 rounded-2xl border border-hairline/60 bg-surface-card/60 px-3 py-2 sm:flex-row">
                <span className="text-[11px] text-muted tabular-nums">
                  {formatNumber((currentPage - 1) * HISTORY_PAGE_SIZE + 1)}–
                  {formatNumber(
                    Math.min(
                      currentPage * HISTORY_PAGE_SIZE,
                      filteredSessions.length,
                    ),
                  )}
                  {' / '}
                  {formatNumber(filteredSessions.length)}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      dispatchQuery({
                        type: 'page',
                        value: Math.max(1, currentPage - 1),
                      })
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
  const { t } = useI18n();
  return (
    <div
      className="space-y-2.5"
      role="status"
      aria-label={t('sidebar.loadingSessions')}
    >
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
