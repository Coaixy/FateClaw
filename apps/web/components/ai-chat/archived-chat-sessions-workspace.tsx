'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import {
  Archive,
  ChevronLeft,
  Clock3,
  Loader2,
  MessageCircle,
  RotateCcw,
  Search,
  Users,
  X,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { chatSessionsApi, type ChatSession } from '@/features/chat/api';
import { useChatSessions } from '@/features/chat/hooks/use-chat-sessions';
import { useClientProfiles } from '@/features/chat/hooks/use-client-profiles';
import { useToast } from '@/lib/use-toast';

/**
 * 归档会话的拉取状态：列表数据、加载中标记与错误提示。
 *
 * 三者同属一次远程拉取的结果，故合并为 reducer；搜索/客户过滤/恢复中仍是独立 state。
 */
interface ArchivedLoadState {
  sessions: ChatSession[];
  loading: boolean;
  error: string;
}

type ArchivedLoadAction =
  | { type: 'loadStart' }
  | { type: 'loadSuccess'; sessions: ChatSession[] }
  | { type: 'loadError'; message: string }
  | { type: 'removeSession'; id: string };

function archivedLoadReducer(
  state: ArchivedLoadState,
  action: ArchivedLoadAction,
): ArchivedLoadState {
  switch (action.type) {
    case 'loadStart':
      return { ...state, loading: true, error: '' };
    case 'loadSuccess':
      return { sessions: action.sessions, loading: false, error: '' };
    case 'loadError':
      return { ...state, loading: false, error: action.message };
    case 'removeSession':
      // 恢复成功后把该会话从归档列表中剔除。
      return {
        ...state,
        sessions: state.sessions.filter(
          (session) => session.id !== action.id,
        ),
      };
  }
}

function formatArchivedTime(value?: string | null) {
  if (!value) return '未知时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ArchivedSessionsContent() {
  const { restoreSession } = useChatSessions();
  const { toast } = useToast();
  const { profiles: clientProfiles, loadProfiles: loadClientProfiles } =
    useClientProfiles(() => {});
  const [loadState, loadDispatch] = useReducer(archivedLoadReducer, {
    sessions: [],
    loading: true,
    error: '',
  });
  const { sessions, loading, error } = loadState;
  const [search, setSearch] = useState('');
  const [clientFilter, setClientFilter] = useState('all');
  const [restoringSessionId, setRestoringSessionId] = useState('');

  const loadArchivedSessions = useCallback(async () => {
    loadDispatch({ type: 'loadStart' });
    try {
      loadDispatch({
        type: 'loadSuccess',
        sessions: await chatSessionsApi.archived(),
      });
    } catch (err) {
      loadDispatch({
        type: 'loadError',
        message: err instanceof Error ? err.message : '加载归档对话失败',
      });
    }
  }, []);

  useEffect(() => {
    void loadArchivedSessions();
  }, [loadArchivedSessions]);

  useEffect(() => {
    void loadClientProfiles().catch(() => {});
  }, [loadClientProfiles]);

  // 客户名 join 表，用于卡片展示与过滤下拉。
  const clientNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const profile of clientProfiles) {
      map.set(profile.id, profile.name);
    }
    return map;
  }, [clientProfiles]);

  // 过滤下拉只列出在归档会话里真正出现过的客户，避免列出无关客户。
  const clientFilterOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const session of sessions) {
      if (session.client_id) ids.add(session.client_id);
    }
    return Array.from(ids).map((id) => ({
      id,
      name: clientNameById.get(id) ?? '未知客户',
    }));
  }, [clientNameById, sessions]);

  const normalizedSearch = search.trim().toLowerCase();
  const filteredSessions = useMemo(() => {
    return sessions.filter((session) => {
      if (clientFilter !== 'all' && session.client_id !== clientFilter) {
        return false;
      }
      if (
        normalizedSearch &&
        !session.title.toLowerCase().includes(normalizedSearch)
      ) {
        return false;
      }
      return true;
    });
  }, [clientFilter, normalizedSearch, sessions]);

  const restoreArchivedSession = async (sessionId: string) => {
    if (restoringSessionId) return;
    setRestoringSessionId(sessionId);
    try {
      await restoreSession(sessionId);
      loadDispatch({ type: 'removeSession', id: sessionId });
      toast('success', '已恢复到最近对话');
    } catch (err) {
      toast(
        'error',
        err instanceof Error ? err.message : '恢复归档对话失败，请稍后重试',
      );
    } finally {
      setRestoringSessionId('');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <Link
            href="/ai-chat"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-hairline bg-surface-card px-3 text-[13px] font-medium text-muted transition-colors hover:border-primary/30 hover:text-ink"
          >
            <ChevronLeft size={15} strokeWidth={1.8} />
            最近对话
          </Link>
          <div className="mt-5 flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
              <Archive size={18} strokeWidth={1.8} />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight text-ink">
                归档对话
              </h1>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">
                共 {sessions.length.toLocaleString()} 个会话
              </p>
            </div>
          </div>
        </div>

        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
          {clientFilterOptions.length > 0 && (
            <div className="relative w-full sm:w-[180px]">
              <Users
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted/70"
              />
              <select
                value={clientFilter}
                onChange={(event) => setClientFilter(event.target.value)}
                aria-label="按客户过滤"
                className="h-10 w-full appearance-none rounded-xl border border-hairline bg-canvas pl-9 pr-8 text-[13px] text-ink transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
              >
                <option value="all">全部客户</option>
                {clientFilterOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="relative w-full sm:w-[280px]">
            <Search
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted/70"
            />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索归档标题..."
              className="h-10 w-full rounded-xl border border-hairline bg-canvas pl-9 pr-9 text-[13px] text-ink placeholder:text-muted/70 transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted/70 transition-colors hover:bg-surface-card hover:text-ink"
                aria-label="清空搜索"
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>
      </div>

      {loading ? (
        <div
          className="flex min-h-[220px] items-center justify-center rounded-xl border border-hairline bg-surface-card/60"
          role="status"
          aria-label="正在加载归档对话"
        >
          <Loader2 size={20} className="animate-spin text-muted" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-error/20 bg-error/5 px-4 py-3 text-[13px] text-error">
          {error}
        </div>
      ) : sessions.length === 0 ? (
        <div className="flex min-h-[260px] flex-col items-center justify-center rounded-xl border border-hairline bg-surface-card/60 px-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-canvas text-muted/55">
            <Archive size={20} strokeWidth={1.8} />
          </div>
          <p className="mt-3 text-[14px] font-medium text-ink">暂无归档对话</p>
          <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-muted">
            还没有需要收纳的历史会话。
          </p>
        </div>
      ) : filteredSessions.length === 0 ? (
        <div className="flex min-h-[220px] flex-col items-center justify-center rounded-xl border border-hairline bg-surface-card/60 px-6 text-center">
          <Search size={20} className="text-muted/55" strokeWidth={1.8} />
          <p className="mt-3 text-[13px] text-muted">
            {search.trim()
              ? `没有匹配“${search.trim()}”的归档对话`
              : '该客户暂无匹配的归档对话'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredSessions.map((session) => {
            const restoring = restoringSessionId === session.id;
            return (
              <div
                key={session.id}
                className="flex flex-col gap-3 rounded-xl border border-hairline bg-surface-card/70 px-4 py-3 transition-colors hover:border-primary/25 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-canvas text-muted">
                    <MessageCircle size={15} strokeWidth={1.8} />
                  </div>
                  <div className="min-w-0">
                    <p className="break-words text-[14px] font-medium text-ink">
                      {session.title}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
                      <span className="inline-flex items-center gap-1">
                        <Clock3 size={12} strokeWidth={1.8} />
                        归档于{' '}
                        {formatArchivedTime(session.deleted_at ?? null)}
                      </span>
                      {session.client_id &&
                        clientNameById.get(session.client_id) && (
                          <span className="inline-flex items-center gap-1">
                            <Users size={12} strokeWidth={1.8} />
                            {clientNameById.get(session.client_id)}
                          </span>
                        )}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void restoreArchivedSession(session.id)}
                  disabled={Boolean(restoringSessionId)}
                  className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-primary/25 bg-primary/10 px-3 text-[13px] font-medium text-primary transition-colors hover:bg-primary/15 disabled:cursor-wait disabled:opacity-60"
                >
                  {restoring ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <RotateCcw size={14} strokeWidth={1.8} />
                  )}
                  {restoring ? '恢复中...' : '恢复'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * AI Chat 归档会话页面。
 *
 * @returns 带侧边栏外壳的归档会话管理视图。
 */
export function ArchivedChatSessionsWorkspace() {
  return (
    <AppShell>
      <ArchivedSessionsContent />
    </AppShell>
  );
}
