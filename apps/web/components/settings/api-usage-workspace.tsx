'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertCircle,
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  Info,
  KeyRound,
  MessageSquare,
  RefreshCw,
  Search,
} from 'lucide-react';

import { DeveloperShell } from '@/components/developer/developer-shell';
import { CopyButton } from '@/components/developer/code-block';
import { Button } from '@/components/ui/button';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { ApiError } from '@/lib/http/client';
import { useAuth } from '@/features/auth/hooks/use-auth';
import {
  apiUsageApi,
  type ApiSessionListItem,
  type ApiSessionMessage,
} from '@/features/api-usage/api-usage-api';
import { billingApi, type UsageStats } from '@/features/billing/api';

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toLocaleDateString('sv-SE')} ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

function formatInt(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('en-US')
    : '—';
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function sessionStatus(session: ApiSessionListItem) {
  if (session.status === 'deleted') return 'deleted';
  if (
    session.expires_at &&
    new Date(session.expires_at).getTime() <= Date.now()
  )
    return 'expired';
  return 'active';
}

const STATUS_LABEL = {
  active: '活跃',
  deleted: '已删除',
  expired: '已过期',
} as const;

export function ApiUsageWorkspace() {
  const { user } = useAuth();
  const [sessions, setSessions] = useState<ApiSessionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [keyName, setKeyName] = useState('');
  const [status, setStatus] = useState('all');
  const [period, setPeriod] = useState('all');
  const [detail, setDetail] = useState<{
    session: ApiSessionListItem | null;
    messages: ApiSessionMessage[];
    loading: boolean;
    error: string;
  }>({ session: null, messages: [], loading: false, error: '' });
  const loadVersion = useRef(0);
  const detailVersion = useRef(0);

  const refresh = useCallback(async () => {
    if (!user) return;
    const version = ++loadVersion.current;
    setLoading(true);
    setUsageLoading(true);
    setLoadError('');
    // Account totals are independent of session history and must not block it.
    const accountRequest = billingApi.usage().then(
      (nextUsage) => {
        if (version === loadVersion.current) {
          setUsage(nextUsage);
          setUsageLoading(false);
        }
      },
      () => {
        if (version === loadVersion.current) {
          setUsage(null);
          setUsageLoading(false);
        }
      },
    );
    try {
      const response = await apiUsageApi.listSessions();
      if (version === loadVersion.current) setSessions(response.sessions);
    } catch (error) {
      if (version === loadVersion.current)
        setLoadError(errorMessage(error, '会话记录加载失败，请重试'));
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
    await accountRequest;
  }, [user]);

  useEffect(() => {
    void refresh();
    return () => {
      loadVersion.current += 1;
      detailVersion.current += 1;
    };
  }, [refresh]);

  async function openSession(session: ApiSessionListItem) {
    const version = ++detailVersion.current;
    setDetail({ session, messages: [], loading: true, error: '' });
    try {
      const response = await apiUsageApi.sessionMessages(session.id);
      if (version === detailVersion.current)
        setDetail({
          session,
          messages: response.messages,
          loading: false,
          error: '',
        });
    } catch (error) {
      if (version === detailVersion.current)
        setDetail({
          session,
          messages: [],
          loading: false,
          error: errorMessage(error, '对话加载失败，请重试'),
        });
    }
  }

  function closeSession() {
    detailVersion.current += 1;
    setDetail({ session: null, messages: [], loading: false, error: '' });
  }

  function clearFilters() {
    setSearch('');
    setKeyName('');
    setStatus('all');
    setPeriod('all');
  }

  const keyNames = Array.from(
    new Set(
      sessions.flatMap((session) =>
        session.api_key_name ? [session.api_key_name] : [],
      ),
    ),
  );
  const filtered = sessions.filter((session) => {
    const matchesSearch =
      `${session.id} ${session.model} ${session.api_key_name ?? ''}`
        .toLowerCase()
        .includes(search.trim().toLowerCase());
    const matchesPeriod =
      period === 'all' ||
      new Date(session.last_active_at).getTime() >=
        Date.now() - Number(period) * 86_400_000;
    return (
      matchesSearch &&
      matchesPeriod &&
      (!keyName || session.api_key_name === keyName) &&
      (status === 'all' || sessionStatus(session) === status)
    );
  });
  const hasFilters = Boolean(
    search || keyName || status !== 'all' || period !== 'all',
  );
  const apiMessageTotal = sessions.reduce(
    (sum, session) => sum + session.message_count,
    0,
  );

  return (
    <DeveloperShell
      active="usage"
      title="使用详情"
      description="追踪 API 会话、查看完整对话，让每次接入都有迹可循。"
      actions={
        <Link
          href="/docs/api"
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-hairline bg-surface-raised px-4 text-xs text-ink hover:border-primary/40"
        >
          查看 API 文档
          <ArrowUpRight size={14} />
        </Link>
      }
    >
      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          label="API 会话"
          value={loading ? '…' : loadError ? '—' : formatInt(sessions.length)}
          hint="最近 100 条会话"
          scope="API"
        />
        <StatCard
          label="会话消息"
          value={loading ? '…' : loadError ? '—' : formatInt(apiMessageTotal)}
          hint="上述会话内收发消息"
          scope="API"
        />
        <StatCard
          label="本月消息"
          value={usageLoading ? '…' : formatInt(usage?.monthly_messages)}
          hint="含站内与 API 对话"
          scope="账户整体"
        />
        <StatCard
          label="累计 Token"
          value={usageLoading ? '…' : formatInt(usage?.total_tokens)}
          hint="含站内与 API 对话"
          scope="账户整体"
        />
      </div>
      <div className="mb-8 flex items-start gap-2 text-[11px] leading-6 text-muted">
        <Info size={13} className="mt-1 shrink-0" aria-hidden="true" />
        <p>
          API 统计基于最近 100 条会话；Token
          与本月消息为账户整体用量，暂不单独拆分 API 消耗。
          {!usageLoading && !usage && (
            <span className="ml-1">
              账户用量暂不可用。
              <button
                type="button"
                onClick={() => void refresh()}
                className="text-primary underline"
              >
                重试
              </button>
            </span>
          )}
        </p>
      </div>

      <section aria-labelledby="api-sessions-title">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h2
              id="api-sessions-title"
              className="text-[17px] font-medium text-ink"
            >
              API 会话记录
            </h2>
            <p className="mt-1.5 text-xs leading-6 text-muted">
              按最近活动排序，点击会话查看完整对话。记录独立于站内聊天历史。
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={() => void refresh()}
            icon={
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            }
          >
            刷新
          </Button>
        </div>

        <div className="overflow-hidden rounded-xl border border-hairline bg-surface-raised">
          <div className="flex flex-wrap items-center gap-2 border-b border-hairline p-3 sm:p-4">
            <label className="flex h-9 min-w-0 basis-full items-center gap-2 rounded-lg border border-hairline bg-canvas px-3 xl:min-w-48 xl:flex-1 xl:basis-auto">
              <Search
                size={14}
                className="shrink-0 text-muted"
                aria-hidden="true"
              />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索会话 ID、模型或 Key 名称"
                aria-label="搜索 API 会话"
                className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-muted-soft"
              />
            </label>
            <select
              value={keyName}
              onChange={(event) => setKeyName(event.target.value)}
              aria-label="按 Key 名称筛选"
              className="h-9 min-w-0 max-w-48 flex-1 rounded-lg border border-hairline bg-canvas px-2 text-[11px] text-body xl:flex-none"
            >
              <option value="">所有 Key 名称</option>
              {keyNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              aria-label="按会话状态筛选"
              className="h-9 min-w-0 flex-1 rounded-lg border border-hairline bg-canvas px-2 text-[11px] text-body xl:flex-none"
            >
              <option value="all">所有状态</option>
              <option value="active">活跃</option>
              <option value="expired">已过期</option>
              <option value="deleted">已删除</option>
            </select>
            <select
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
              aria-label="按最近活动筛选"
              className="h-9 min-w-0 flex-1 rounded-lg border border-hairline bg-canvas px-2 text-[11px] text-body xl:flex-none"
            >
              <option value="all">全部时间</option>
              <option value="7">最近 7 天</option>
              <option value="30">最近 30 天</option>
            </select>
          </div>

          {loadError && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 border-b border-error/15 bg-error/5 px-5 py-3 text-xs text-error"
            >
              <span className="inline-flex items-center gap-2">
                <AlertCircle size={14} />
                {loadError}
              </span>
              <button
                type="button"
                onClick={() => void refresh()}
                className="min-h-8 font-medium underline"
              >
                重新加载
              </button>
            </div>
          )}
          {loading && sessions.length === 0 ? (
            <div role="status" className="py-16 text-center text-xs text-muted">
              正在加载会话记录…
            </div>
          ) : sessions.length === 0 && !loadError ? (
            <div className="px-5 py-14 text-center">
              <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-hairline bg-surface-soft text-primary">
                <Activity size={21} />
              </span>
              <h3 className="text-sm font-medium text-ink">
                你的 API 会话将出现在这里
              </h3>
              <p className="mx-auto mt-2 max-w-sm text-xs leading-6 text-muted">
                通过 API 创建 AI
                解读会话后，即可在这里查看记录。排盘计算不创建会话。
              </p>
              <Link
                href="/docs/api#agent-chat"
                className="mt-5 inline-flex min-h-9 items-center gap-1.5 text-xs font-medium text-primary"
              >
                创建第一个 API 会话
                <ArrowRight size={13} />
              </Link>
            </div>
          ) : filtered.length === 0 && !loadError ? (
            <div className="px-5 py-14 text-center text-xs text-muted">
              没有符合条件的会话。
              <button
                type="button"
                onClick={clearFilters}
                className="ml-2 text-primary hover:underline"
              >
                清除筛选
              </button>
            </div>
          ) : sessions.length > 0 ? (
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[800px] text-left text-xs">
                <caption className="sr-only">最近 100 条 API 会话</caption>
                <thead className="border-b border-hairline bg-surface-soft/45 text-[11px] text-muted">
                  <tr>
                    {[
                      '会话 / 模型',
                      'Key 名称',
                      '状态',
                      '消息数',
                      '最近活动',
                      '',
                    ].map((label) => (
                      <th
                        key={label || 'action'}
                        scope="col"
                        className="px-5 py-3 font-normal"
                      >
                        {label || <span className="sr-only">查看</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline/70">
                  {filtered.map((session) => {
                    const currentStatus = sessionStatus(session);
                    return (
                      <tr
                        key={session.id}
                        className="group hover:bg-surface-soft/35"
                      >
                        <th
                          scope="row"
                          className="max-w-72 px-5 py-4 text-left font-normal"
                        >
                          <button
                            type="button"
                            onClick={() => void openSession(session)}
                            className="max-w-full text-left"
                          >
                            <span className="block truncate font-mono text-[11px] text-ink group-hover:text-primary">
                              {session.id}
                            </span>
                            <span className="mt-1.5 block truncate font-mono text-[10px] text-muted">
                              {session.model}
                            </span>
                          </button>
                        </th>
                        <td className="max-w-44 px-5 py-4">
                          <span
                            className="block truncate text-[11px] text-muted"
                            title={session.api_key_name ?? undefined}
                          >
                            {session.api_key_name ?? '—'}
                          </span>
                        </td>
                        <td className="px-5 py-4">
                          <span
                            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[10px] ${currentStatus === 'active' ? 'bg-success/10 text-chart-wood' : 'bg-surface-soft text-muted'}`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${currentStatus === 'active' ? 'bg-success' : 'bg-muted-soft'}`}
                            />
                            {STATUS_LABEL[currentStatus]}
                          </span>
                        </td>
                        <td className="px-5 py-4 font-mono text-[11px] text-muted">
                          {formatInt(session.message_count)}
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 font-mono text-[11px] text-muted">
                          {formatDateTime(session.last_active_at)}
                        </td>
                        <td className="px-3 py-4">
                          <button
                            type="button"
                            onClick={() => void openSession(session)}
                            aria-label={`查看会话 ${session.id}`}
                            className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-soft hover:text-primary"
                          >
                            <ChevronRight size={16} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline bg-canvas/50 px-5 py-3 text-[11px] text-muted">
            <span>
              {loading
                ? '正在同步…'
                : loadError
                  ? '记录暂不可用'
                  : `显示 ${filtered.length} / ${sessions.length} 条会话`}
              {hasFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="ml-3 text-primary hover:underline"
                >
                  清除筛选
                </button>
              )}
            </span>
            <span>最多展示最近 100 条</span>
          </div>
        </div>
      </section>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-hairline bg-surface-soft/40 px-5 py-4">
        <div className="flex items-start gap-3">
          <KeyRound size={17} className="mt-0.5 shrink-0 text-muted" />
          <div>
            <p className="text-xs font-medium text-ink">管理应用的访问权限</p>
            <p className="mt-1 text-[11px] leading-5 text-muted">
              为不同用途创建独立 Key，停用不再使用的密钥。
            </p>
          </div>
        </div>
        <Link
          href="/settings/api-keys"
          className="inline-flex min-h-8 items-center gap-1.5 text-xs font-medium text-primary"
        >
          管理 API Key
          <ArrowRight size={13} />
        </Link>
      </div>

      <BottomSheet
        open={detail.session !== null}
        onClose={closeSession}
        title="会话详情"
        size="lg"
        aria-label="API 会话详情"
      >
        <div className="developer-workspace space-y-6 p-5 sm:p-6">
          {detail.session && (
            <div className="rounded-xl border border-hairline bg-canvas p-4">
              <div className="flex items-start justify-between gap-2">
                <code className="min-w-0 break-all font-mono text-xs leading-7 text-ink">
                  {detail.session.id}
                </code>
                <CopyButton value={detail.session.id} label="复制 ID" />
              </div>
              <dl className="mt-3 grid grid-cols-1 gap-3 border-t border-hairline pt-3 text-[11px] sm:grid-cols-2">
                <div>
                  <dt className="text-muted">模型</dt>
                  <dd className="mt-1 break-all font-mono text-ink">
                    {detail.session.model}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Key 名称</dt>
                  <dd className="mt-1 break-all text-ink">
                    {detail.session.api_key_name ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">创建时间</dt>
                  <dd className="mt-1 font-mono text-ink">
                    {formatDateTime(detail.session.created_at)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">状态 / 到期时间</dt>
                  <dd className="mt-1 text-ink">
                    {STATUS_LABEL[sessionStatus(detail.session)]}
                    {detail.session.expires_at
                      ? ` · ${formatDateTime(detail.session.expires_at)}`
                      : ''}
                  </dd>
                </div>
              </dl>
            </div>
          )}
          <div className="flex items-center gap-2 text-xs font-medium text-ink">
            <MessageSquare size={15} />
            对话记录
            {!detail.loading && !detail.error && (
              <span className="font-mono font-normal text-muted">
                {detail.messages.length}
              </span>
            )}
          </div>
          {detail.loading ? (
            <div role="status" className="py-10 text-center text-xs text-muted">
              正在加载对话…
            </div>
          ) : detail.error ? (
            <div
              role="alert"
              className="rounded-lg bg-error/5 p-4 text-xs text-error"
            >
              {detail.error}
              <button
                type="button"
                onClick={() => {
                  if (detail.session) void openSession(detail.session);
                }}
                className="ml-3 min-h-8 underline"
              >
                重试
              </button>
            </div>
          ) : detail.messages.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted">
              此会话还没有对话内容。
            </p>
          ) : (
            <div className="space-y-5">
              {detail.messages.map((message) => (
                <article
                  key={message.id}
                  className={`rounded-xl border p-4 ${message.role === 'user' ? 'border-hairline bg-surface-soft/60' : 'border-primary/15 bg-primary/3'}`}
                >
                  <header className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                    <span
                      className={`font-medium ${message.role === 'user' ? 'text-muted' : 'text-primary'}`}
                    >
                      {message.role === 'user' ? '用户' : 'AI 助手'}
                    </span>
                    <time
                      dateTime={message.created_at}
                      className="font-mono text-[10px] text-muted"
                    >
                      {formatDateTime(message.created_at)}
                    </time>
                  </header>
                  <p className="whitespace-pre-wrap break-words text-[13px] leading-7 text-body">
                    {message.content}
                  </p>
                </article>
              ))}
            </div>
          )}
        </div>
      </BottomSheet>
    </DeveloperShell>
  );
}

function StatCard({
  label,
  value,
  hint,
  scope,
}: {
  label: string;
  value: string;
  hint: string;
  scope: string;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-surface-raised p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted">{label}</span>
        <span
          className={`rounded px-1.5 py-0.5 text-[9px] ${scope === 'API' ? 'bg-primary/8 font-mono text-primary' : 'bg-surface-soft text-muted'}`}
        >
          {scope}
        </span>
      </div>
      <div className="mt-4 font-mono text-[26px] font-medium tracking-tight text-ink sm:text-[30px]">
        {value}
      </div>
      <p className="mt-2 text-[10px] leading-5 text-muted">{hint}</p>
    </div>
  );
}
