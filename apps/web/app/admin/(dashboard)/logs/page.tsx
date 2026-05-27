'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  admin,
  adminLogs,
  AdminAccount,
  AdminUser,
  ConversationLog,
  ConversationLogSummary,
} from '@/lib/admin-api';
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Hash,
  Loader2,
  MessageSquare,
  RefreshCw,
  ScrollText,
  Search,
  Wrench,
  X,
} from 'lucide-react';

import {
  FinalOutputCard,
  TranscriptEventView,
  UsageBreakdown,
  extractFinalOutput,
} from './log-detail-components';
import { normalizeConversationLog } from './log-normalizers';
import { ReadableLogSummary } from './log-readable-summary';
import { formatTime, tokenLabel } from './log-utils';
import { TraceTimeline } from './trace-timeline';

const WEB_CHAT_RUNTIME_PREFIX = 'web:';
const WEB_CHAT_ACCOUNT_LABEL = '站内 AI Chat';
const LOG_PAGE_SIZE = 20;

const ERROR_TRACE_TYPES = new Set([
  'tool_error',
  'rate_limit',
  'context_too_long',
  'context_trimmed',
  'protocol_violation',
  'truncated_tool_calls_fallback',
  'trace_overflow',
]);

function getWebChatRuntimeId(userId: string): string {
  return `${WEB_CHAT_RUNTIME_PREFIX}${userId}`;
}

function buildLogAccountOptions(
  userId: string,
  accounts: AdminAccount[],
): Array<{ id: string; name: string }> {
  const realAccounts = accounts.map((account) => ({
    id: account.id,
    name: account.name || account.id,
  }));
  const webChatAccountId = getWebChatRuntimeId(userId);
  if (realAccounts.some((account) => account.id === webChatAccountId)) {
    return realAccounts;
  }
  return [
    { id: webChatAccountId, name: WEB_CHAT_ACCOUNT_LABEL },
    ...realAccounts,
  ];
}

function hasTraceErrorEvent(events: ConversationLog['trace_events']): boolean {
  return events?.some((event) => ERROR_TRACE_TYPES.has(event.type)) ?? false;
}

function LogCard({
  summary,
  preloadedFull,
}: {
  summary: ConversationLogSummary;
  preloadedFull?: ConversationLog | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [fullLog, setFullLog] = useState<ConversationLog | null>(
    preloadedFull ?? null,
  );
  const [loadingFull, setLoadingFull] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [hasErrorEvent, setHasErrorEvent] = useState(() =>
    hasTraceErrorEvent(preloadedFull?.trace_events ?? null),
  );
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const showErrorRing =
    hasErrorEvent || summary.agent_graph_summary?.usedRuntimeGuards === true;

  const handleToggle = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (!fullLog && !loadingFull) {
      setLoadingFull(true);
      setLoadError('');
      try {
        const full = normalizeConversationLog(await adminLogs.get(summary.id));
        setFullLog(full);
        setHasErrorEvent(hasTraceErrorEvent(full.trace_events));
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : '加载失败');
      } finally {
        setLoadingFull(false);
      }
    }
  };

  return (
    <div
      className={`border rounded-lg bg-surface-card transition-colors ${
        showErrorRing
          ? 'border-red-500/40 bg-red-500/[0.03]'
          : 'border-hairline'
      }`}
    >
      <button
        onClick={handleToggle}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left cursor-pointer hover:bg-surface-cream-strong rounded-lg transition-colors"
      >
        <div className="flex items-center gap-1 shrink-0">
          <Chevron size={14} className="text-muted" />
          {showErrorRing && (
            <AlertTriangle size={11} className="text-red-400" />
          )}
        </div>

        <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
          <span className="text-[13px] tabular-nums text-ink shrink-0">
            {formatTime(summary.created_at)}
          </span>
          {summary.provider && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 shrink-0">
              {summary.provider}
            </span>
          )}
          {summary.model && (
            <span className="text-muted font-mono text-[10px] bg-canvas px-1.5 py-0.5 rounded max-w-[180px] truncate">
              {summary.model}
            </span>
          )}
          {summary.agent_graph_summary && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 shrink-0">
              agent
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 text-[11px] text-muted shrink-0">
          {summary.usage && (
            <span className="flex items-center gap-1 font-mono">
              <span className="text-blue-400/70">
                {tokenLabel(summary.usage.promptTokens)}↑
              </span>
              <span className="text-amber-400/70">
                {tokenLabel(summary.usage.completionTokens)}↓
              </span>
            </span>
          )}
          {summary.tool_call_count > 0 && (
            <span className="flex items-center gap-0.5">
              <Wrench size={10} />
              {summary.tool_call_count}
            </span>
          )}
          {summary.trace_event_count > 0 && (
            <span className="flex items-center gap-0.5">
              <Activity size={10} />
              {summary.trace_event_count}
            </span>
          )}
          <span className="font-mono opacity-50 flex items-center gap-0.5">
            <Hash size={9} />
            {summary.request_id.slice(0, 8)}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-hairline">
          {loadingFull && (
            <div className="flex justify-center py-4">
              <Loader2
                size={16}
                className="animate-spin text-muted"
              />
            </div>
          )}
          {loadError && !loadingFull && (
            <div className="mt-2 text-[12px] text-error">
              加载详情失败：{loadError}
            </div>
          )}
          {fullLog && !loadingFull && (
            <>
              <ReadableLogSummary log={fullLog} />
              <UsageBreakdown
                usage={fullLog.usage}
                traceEvents={fullLog.trace_events}
              />
              <FinalOutputCard text={extractFinalOutput(fullLog)} />
              <div className="mt-2 space-y-0.5">
                {fullLog.transcript.map((event, i) => (
                  <TranscriptEventView key={i} event={event} />
                ))}
              </div>
              <TraceTimeline events={fullLog.trace_events ?? []} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function AdminLogsPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [logList, setLogList] = useState<ConversationLogSummary[]>([]);
  const [preloadedFull, setPreloadedFull] = useState<ConversationLog | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState('');
  const [requestIdQuery, setRequestIdQuery] = useState('');
  const [searchMode, setSearchMode] = useState(false);
  const [searchError, setSearchError] = useState('');

  useEffect(() => {
    admin
      .users()
      .then((u) => {
        setUsers(u);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : '加载失败');
        setLoading(false);
      });
  }, []);

  const loadAccounts = useCallback(async (userId: string) => {
    if (!userId) {
      setAccounts([]);
      setSelectedAccountId('');
      return;
    }
    try {
      const detail = await admin.userDetail(userId);
      const accs = buildLogAccountOptions(userId, detail.accounts);
      setAccounts(accs);
      if (accs.length > 0) {
        setSelectedAccountId(accs[0].id);
      } else {
        setSelectedAccountId('');
      }
    } catch {
      setAccounts([]);
      setSelectedAccountId('');
    }
  }, []);

  useEffect(() => {
    loadAccounts(selectedUserId);
  }, [selectedUserId, loadAccounts]);

  const fetchLogs = useCallback(async (accountId: string, before?: string) => {
    if (!accountId) return;
    setLogsLoading(true);
    try {
      const fetched = await adminLogs.list(accountId, LOG_PAGE_SIZE, before);
      if (before) {
        setLogList((prev) => [...prev, ...fetched]);
      } else {
        setLogList(fetched);
      }
      setHasMore(fetched.length >= LOG_PAGE_SIZE);
    } catch {
      setLogList([]);
    } finally {
      setLogsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedAccountId) {
      setLogList([]);
      setHasMore(true);
      fetchLogs(selectedAccountId);
    } else {
      setLogList([]);
    }
  }, [selectedAccountId, fetchLogs]);

  const loadMore = () => {
    if (logList.length === 0 || !hasMore) return;
    const oldest = logList[logList.length - 1].created_at;
    fetchLogs(selectedAccountId, oldest);
  };

  const handleRefresh = () => {
    if (selectedAccountId) {
      setLogList([]);
      setHasMore(true);
      fetchLogs(selectedAccountId);
    }
  };

  const handleRequestIdSearch = async () => {
    const q = requestIdQuery.trim();
    if (!q) return;
    setSearchError('');
    setLogsLoading(true);
    try {
      const log = normalizeConversationLog(await adminLogs.getByRequestId(q));
      const summary: ConversationLogSummary = {
        id: log.id,
        account_id: log.account_id,
        request_id: log.request_id,
        agent_graph_summary: log.agent_graph_summary,
        usage: log.usage,
        model: log.model,
        provider: log.provider,
        created_at: log.created_at,
        tool_call_count: log.transcript.filter((e) => e.type === 'tool_use')
          .length,
        transcript_event_count: log.transcript.length,
        trace_event_count: log.trace_events?.length ?? 0,
      };
      setLogList([summary]);
      setPreloadedFull(log);
      setSearchMode(true);
      setHasMore(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '搜索失败';
      setSearchError(msg.includes('404') ? '未找到该 request_id' : msg);
      setLogList([]);
      setPreloadedFull(null);
      setSearchMode(true);
      setHasMore(false);
    } finally {
      setLogsLoading(false);
    }
  };

  const handleClearSearch = () => {
    setRequestIdQuery('');
    setSearchMode(false);
    setSearchError('');
    setPreloadedFull(null);
    if (selectedAccountId) {
      setLogList([]);
      setHasMore(true);
      fetchLogs(selectedAccountId);
    } else {
      setLogList([]);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 size={20} className="animate-spin text-muted" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-20 text-error">{error}</div>
    );
  }

  const inputCls =
    'h-8 text-[13px] bg-canvas border border-hairline rounded-md px-2.5 focus:outline-none focus:border-hairline transition-colors';

  return (
    <div className="max-w-4xl">
      <div className="flex items-center gap-2 mb-5">
        <ScrollText size={16} className="text-muted" />
        <h1 className="text-lg font-semibold">对话日志</h1>
        <button
          onClick={handleRefresh}
          className="ml-1 p-1.5 rounded-md text-muted hover:text-ink transition-colors cursor-pointer"
          title="刷新"
        >
          <RefreshCw size={13} />
        </button>
        {logsLoading && (
          <Loader2
            size={13}
            className="animate-spin text-muted ml-1"
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-5 p-3 rounded-xl border border-hairline bg-surface-card">
        <div className="flex items-center gap-2">
          <select
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            className={inputCls}
          >
            <option value="">选择用户</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.phone}
              </option>
            ))}
          </select>

          {accounts.length > 0 && (
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className={inputCls}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-1.5">
          <div className="relative">
            <Search
              size={12}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
            />
            <input
              type="text"
              value={requestIdQuery}
              onChange={(e) => setRequestIdQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRequestIdSearch();
              }}
              placeholder="request_id"
              className={`${inputCls} pl-7 w-[200px] font-mono placeholder:text-muted placeholder:font-sans`}
            />
          </div>
          {searchMode && (
            <button
              onClick={handleClearSearch}
              className="h-8 px-2 rounded-md text-muted hover:text-ink hover:bg-surface-cream-strong transition-colors cursor-pointer"
              title="清除搜索"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {searchError && (
        <div className="mb-3 text-[12px] text-error">
          {searchError}
        </div>
      )}

      {logList.length === 0 && !logsLoading && !searchError && (
        <div className="text-center py-12 text-muted text-sm">
          <MessageSquare size={32} className="mx-auto mb-2 opacity-30" />
          <p>
            {searchMode
              ? '搜索无结果'
              : selectedAccountId
                ? '暂无对话日志'
                : '请先选择用户和账号'}
          </p>
        </div>
      )}

      <div className="space-y-2">
        {logList.map((summary) => (
          <LogCard
            key={summary.id}
            summary={summary}
            preloadedFull={
              searchMode && preloadedFull?.id === summary.id
                ? preloadedFull
                : null
            }
          />
        ))}
      </div>

      {logsLoading && (
        <div className="flex justify-center py-4">
          <Loader2
            size={20}
            className="animate-spin text-muted"
          />
        </div>
      )}

      {hasMore && logList.length > 0 && !logsLoading && (
        <div className="flex justify-center py-4">
          <button
            onClick={loadMore}
            className="text-[13px] text-muted hover:text-ink cursor-pointer"
          >
            加载更多
          </button>
        </div>
      )}
    </div>
  );
}
