'use client';

import { useCallback, useEffect, useReducer } from 'react';
import Link from 'next/link';
import { Activity, ArrowLeft, KeyRound, MessageSquare } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { ApiError } from '@/lib/http/client';
import {
  apiUsageApi,
  type ApiSessionListItem,
  type ApiSessionMessage,
} from '@/features/api-usage/api-usage-api';
import { billingApi, type UsageStats } from '@/features/billing/api';

/** 把 ISO 时间格式化为 YYYY-MM-DD HH:mm；非法日期返回占位符，避免脏数据导致整页崩溃。 */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 千分位整数格式化；非数字返回占位符。 */
function formatInt(n: number | undefined | null): string {
  if (typeof n !== 'number' || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

/** 从 ApiError 取可读文案，兜底默认提示。 */
function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** 页面主数据加载状态：会话列表、账户用量、加载中、错误文案。 */
type ListState = {
  sessions: ApiSessionListItem[];
  usage: UsageStats | null;
  loading: boolean;
  error: string | null;
};

type ListAction =
  | { type: 'loadStart' }
  | { type: 'loaded'; sessions: ApiSessionListItem[] }
  | { type: 'failed'; error: string }
  | { type: 'setUsage'; usage: UsageStats | null };

/**
 * 列表 reducer：会话列表拉取的三态流转，外加用量的独立写入。
 * 用量是辅助信息（失败只置 null、不影响主列表），因此用单独 action 承载。
 */
function listReducer(state: ListState, action: ListAction): ListState {
  switch (action.type) {
    case 'loadStart':
      return { ...state, loading: true, error: null };
    case 'loaded':
      return { ...state, sessions: action.sessions, loading: false };
    case 'failed':
      return { ...state, error: action.error, loading: false };
    case 'setUsage':
      return { ...state, usage: action.usage };
    default:
      return state;
  }
}

const LIST_INITIAL: ListState = {
  sessions: [],
  usage: null,
  loading: true,
  error: null,
};

/** 对话详情状态：选中的会话、其消息、消息加载中、消息错误。 */
type DetailState = {
  session: ApiSessionListItem | null;
  messages: ApiSessionMessage[];
  loading: boolean;
  error: string | null;
};

type DetailAction =
  | { type: 'open'; session: ApiSessionListItem }
  | { type: 'loaded'; messages: ApiSessionMessage[] }
  | { type: 'failed'; error: string }
  | { type: 'close' };

/** 详情 reducer：打开会话即重置消息并进入加载，成功/失败各自复位 loading。 */
function detailReducer(state: DetailState, action: DetailAction): DetailState {
  switch (action.type) {
    case 'open':
      return {
        session: action.session,
        messages: [],
        loading: true,
        error: null,
      };
    case 'loaded':
      return { ...state, messages: action.messages, loading: false };
    case 'failed':
      return { ...state, error: action.error, loading: false };
    case 'close':
      return { ...state, session: null };
    default:
      return state;
  }
}

const DETAIL_INITIAL: DetailState = {
  session: null,
  messages: [],
  loading: false,
  error: null,
};

/**
 * API 使用详情设置页（站内，需登录）。
 *
 * 列出当前用户经 API Key 创建的对外会话（含已软删），点开可查看完整对话。
 * 顶部展示用量概览：API 会话数 / 消息数为精确归属指标；本月消息 / 累计 Token 为账户整体用量
 * （含站内对话），因为后端 daily_usage 未按 API 调用单独拆分 Token。
 */
export function ApiUsageWorkspace() {
  // 页面主数据（会话列表 + 用量）合并为一个 reducer；保留 sessions/usage/loading/loadError 读名。
  const [{ sessions, usage, loading, error: loadError }, listDispatch] =
    useReducer(listReducer, LIST_INITIAL);

  // 对话详情：选中会话 + 其消息合并为一个 reducer；保留 activeSession/messages/msgLoading/msgError 读名。
  const [
    {
      session: activeSession,
      messages,
      loading: msgLoading,
      error: msgError,
    },
    detailDispatch,
  ] = useReducer(detailReducer, DETAIL_INITIAL);

  const refresh = useCallback(async () => {
    listDispatch({ type: 'loadStart' });
    try {
      const res = await apiUsageApi.listSessions();
      listDispatch({ type: 'loaded', sessions: res.sessions });
    } catch (error) {
      listDispatch({ type: 'failed', error: errorMessage(error, '加载失败，请稍后重试') });
    }
    // 账户整体用量是辅助信息，失败不影响主列表。
    try {
      listDispatch({ type: 'setUsage', usage: await billingApi.usage() });
    } catch {
      listDispatch({ type: 'setUsage', usage: null });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openSession = useCallback(async (session: ApiSessionListItem) => {
    detailDispatch({ type: 'open', session });
    try {
      const res = await apiUsageApi.sessionMessages(session.id);
      detailDispatch({ type: 'loaded', messages: res.messages });
    } catch (error) {
      detailDispatch({
        type: 'failed',
        error: errorMessage(error, '对话加载失败，请稍后重试'),
      });
    }
  }, []);

  const sessionCount = sessions.length;
  const activeCount = sessions.filter((s) => s.status === 'active').length;
  const apiMessageTotal = sessions.reduce((sum, s) => sum + s.message_count, 0);

  return (
    <AppShell wide>
      <div className="mx-auto max-w-4xl">
        {/* 标题区 */}
        <div className="mb-6 border-b border-hairline/70 pb-5">
          <Link
            href="/settings/api-keys"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-1 text-[12px] text-muted transition-colors hover:text-ink"
          >
            <ArrowLeft size={13} />
            返回 API Key
          </Link>
          <h2 className="font-display mt-2 text-xl font-semibold tracking-tight text-ink">
            API 使用详情
          </h2>
          <p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted">
            通过 API Key 程序化创建的会话不会出现在站内聊天历史里，在这里查看它们的调用记录与完整对话。
          </p>
        </div>

        {/* 用量概览 */}
        <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label="API 会话"
            value={`${sessionCount}`}
            hint={`${activeCount} 个活跃`}
          />
          <StatCard
            label="API 消息"
            value={formatInt(apiMessageTotal)}
            hint="累计收发"
          />
          <StatCard
            label="本月消息"
            value={formatInt(usage?.monthly_messages)}
            hint="账户整体"
          />
          <StatCard
            label="累计 Token"
            value={formatInt(usage?.total_tokens)}
            hint="账户整体"
          />
        </div>
        <p className="mb-6 text-[11px] leading-5 text-muted">
          「本月消息 / 累计 Token」为账户整体用量（含站内对话），暂不单独拆分 API 调用的 Token 消耗。
        </p>

        {/* 会话列表 */}
        {loading ? (
          <div className="py-12 text-center text-[13px] text-muted">加载中…</div>
        ) : loadError ? (
          <div className="py-12 text-center text-[13px] text-error">
            {loadError}
          </div>
        ) : sessions.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-hairline py-12 text-center">
            <Activity size={28} className="mx-auto mb-3 text-muted" />
            <p className="text-[13px] text-muted">还没有通过 API 创建的会话。</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => void openSession(s)}
                  className="flex w-full items-center justify-between gap-4 rounded-2xl border border-hairline bg-surface-card p-4 text-left transition-colors hover:border-primary/40"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-medium text-ink">
                        {s.model}
                      </span>
                      {s.status === 'deleted' && (
                        <span className="shrink-0 rounded-md bg-surface-cream-strong px-1.5 py-0.5 text-[11px] text-muted">
                          已删除
                        </span>
                      )}
                    </div>
                    <div className="mt-1 truncate font-mono text-[12px] text-muted">
                      {s.id}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                      <span className="inline-flex items-center gap-1">
                        <MessageSquare size={11} />
                        {s.message_count} 条
                      </span>
                      <span>· 创建 {formatDateTime(s.created_at)}</span>
                      <span>· 最近 {formatDateTime(s.last_active_at)}</span>
                      {s.api_key_name && (
                        <span className="inline-flex items-center gap-1">
                          <KeyRound size={11} />
                          {s.api_key_name}
                        </span>
                      )}
                    </div>
                  </div>
                  <MessageSquare size={16} className="shrink-0 text-muted" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 对话详情 */}
      <BottomSheet
        open={activeSession !== null}
        onClose={() => detailDispatch({ type: 'close' })}
        title="会话对话"
        size="md"
      >
        <div className="space-y-4 p-4 sm:p-6">
          {activeSession && (
            <div className="rounded-xl bg-surface-cream-strong px-3 py-2 text-[12px] text-muted">
              <div className="break-all font-mono text-ink">
                {activeSession.id}
              </div>
              <div className="mt-0.5">
                {activeSession.model} · 创建{' '}
                {formatDateTime(activeSession.created_at)}
              </div>
            </div>
          )}
          {msgLoading ? (
            <div className="py-10 text-center text-[13px] text-muted">
              加载中…
            </div>
          ) : msgError ? (
            <div className="py-10 text-center text-[13px] text-error">
              {msgError}
            </div>
          ) : messages.length === 0 ? (
            <div className="py-10 text-center text-[13px] text-muted">
              该会话还没有对话内容。
            </div>
          ) : (
            <div className="space-y-3">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-[13px] leading-6 ${
                      m.role === 'user'
                        ? 'bg-primary/10 text-ink'
                        : 'bg-surface-cream-strong text-ink'
                    }`}
                  >
                    {m.content}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </BottomSheet>
    </AppShell>
  );
}

/** 用量概览小卡片。 */
function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-hairline bg-surface-card p-4">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold tracking-tight text-ink">
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-muted">{hint}</div>}
    </div>
  );
}
