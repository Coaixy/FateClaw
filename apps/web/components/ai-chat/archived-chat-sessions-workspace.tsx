'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ChevronLeft,
  Clock3,
  Loader2,
  MessageCircle,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { chatSessionsApi, type ChatSession } from '@/features/chat/api';
import { useChatSessions } from '@/features/chat/hooks/use-chat-sessions';
import { useToast } from '@/lib/use-toast';

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
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [restoringSessionId, setRestoringSessionId] = useState('');

  const loadArchivedSessions = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setSessions(await chatSessionsApi.archived());
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载归档对话失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadArchivedSessions();
  }, [loadArchivedSessions]);

  const normalizedSearch = search.trim().toLowerCase();
  const filteredSessions = useMemo(() => {
    if (!normalizedSearch) return sessions;
    return sessions.filter((session) =>
      session.title.toLowerCase().includes(normalizedSearch),
    );
  }, [normalizedSearch, sessions]);

  const restoreArchivedSession = async (sessionId: string) => {
    if (restoringSessionId) return;
    setRestoringSessionId(sessionId);
    try {
      await restoreSession(sessionId);
      setSessions((previous) =>
        previous.filter((session) => session.id !== sessionId),
      );
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
            没有匹配“{search.trim()}”的归档对话
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
