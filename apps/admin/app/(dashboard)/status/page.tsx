'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  Cpu,
  Gauge,
  MessageSquareText,
  RefreshCw,
  RadioTower,
  Sparkles,
  Users,
} from 'lucide-react';

import {
  admin,
  type AdminRuntimeStatus,
  type AdminStatusStats,
} from '@/lib/admin-api';
import { useToast } from '@/lib/use-toast';
import {
  AdminAlert,
  AdminEmptyState,
  AdminLoadingState,
} from '@/components/ui/admin-states';

type TokenUsagePoint = AdminStatusStats['token_usage_series'][number];

function formatCompactNumber(value: number): string {
  if (value < 10000) return value.toLocaleString('zh-CN');
  return value.toLocaleString('zh-CN', {
    notation: 'compact',
    maximumFractionDigits: value < 100000000 ? 1 : 2,
  });
}

function formatShortDate(date: string): string {
  const [, month, day] = date.split('-');
  return `${Number(month)}.${Number(day)}`;
}

function sortTokenUsageByDate(
  rows: TokenUsagePoint[],
  direction: 'asc' | 'desc',
): TokenUsagePoint[] {
  return [...rows].sort((a, b) =>
    direction === 'asc'
      ? a.date.localeCompare(b.date)
      : b.date.localeCompare(a.date),
  );
}

function StatCard({
  icon,
  label,
  code,
  value,
  caption,
}: {
  icon: ReactNode;
  label: string;
  code: string;
  value: string;
  caption: string;
}) {
  return (
    <section className="rounded-xl border border-hairline bg-surface-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-hairline bg-surface-cream-strong text-muted">
          {icon}
        </div>
        <span className="rounded border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-muted">
          {code}
        </span>
      </div>
      <div className="mt-4 text-[12px] text-muted">{label}</div>
      <div className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
        {value}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
        <Gauge size={11} />
        {caption}
      </div>
    </section>
  );
}

function TokenUsagePanel({ stats }: { stats: AdminStatusStats }) {
  const tokenRows = stats.token_usage_series.filter(
    (row) => row.total_tokens > 0,
  );
  const chartRows = sortTokenUsageByDate(tokenRows, 'asc');
  const tableRows = sortTokenUsageByDate(tokenRows, 'desc');
  const maxTokens = Math.max(1, ...chartRows.map((row) => row.total_tokens));
  const totalTokens = tokenRows.reduce((sum, row) => sum + row.total_tokens, 0);
  const peakRow =
    chartRows.length > 0
      ? chartRows.reduce((peak, row) =>
          row.total_tokens > peak.total_tokens ? row : peak,
        )
      : null;

  return (
    <section className="rounded-xl border border-hairline bg-surface-card p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[14px] font-semibold">
            <Cpu size={15} className="text-muted" />
            Token 遥测
          </div>
          <div className="mt-1 text-[12px] text-muted">
            最近 7 天全站输入 / 输出消耗
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          <TelemetryPill
            label="7 日总计"
            value={formatCompactNumber(totalTokens)}
          />
          <TelemetryPill
            label="峰值"
            value={
              peakRow ? formatCompactNumber(peakRow.total_tokens) : '暂无'
            }
          />
        </div>
      </div>

      {tokenRows.length === 0 ? (
        <AdminEmptyState
          icon={Cpu}
          title="暂无 Token 消耗记录"
          description="最近 7 天没有产生 Token 消耗，有请求后这里会展示趋势"
        />
      ) : (
        <>
          <div className="relative flex h-56 items-end gap-3 overflow-hidden rounded-lg border border-hairline bg-canvas px-4 pb-8 pt-4">
            <div
              className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,color-mix(in_srgb,var(--color-ink)_6%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_srgb,var(--color-ink)_6%,transparent)_1px,transparent_1px)] bg-[size:32px_32px]"
              aria-hidden="true"
            />
            {chartRows.map((row) => {
              const totalHeight = Math.max(
                6,
                Math.round((row.total_tokens / maxTokens) * 100),
              );
              const inputRatio = row.input_tokens / row.total_tokens;
              return (
                <div
                  key={row.date}
                  className="relative z-[1] flex h-full min-w-0 flex-1 items-end justify-center"
                >
                  <div
                    className="flex w-full max-w-10 flex-col-reverse overflow-hidden rounded-t-md border border-ink/10 bg-hairline shadow-[0_0_18px_rgba(204,120,92,0.12)]"
                    style={{ height: `${totalHeight}%` }}
                    title={`${row.date}：${formatCompactNumber(row.total_tokens)} Token`}
                  >
                    <div
                      className="bg-primary"
                      style={{
                        height: `${Math.max(0, Math.round(inputRatio * 100))}%`,
                      }}
                    />
                    <div className="flex-1 bg-accent-teal" />
                  </div>
                  <div className="absolute top-[calc(100%+6px)] text-[10px] text-muted">
                    {formatShortDate(row.date)}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-muted">
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-primary" />
              输入 Token
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-accent-teal" />
              输出 Token
            </span>
          </div>

          {/* 外层同时具备横向(min-w)与纵向(max-h)滚动，使 thead sticky 生效 */}
          <div className="mt-3 max-h-72 overflow-auto rounded-lg border border-hairline bg-canvas">
            <table className="w-full min-w-[480px] text-left text-[12px]">
              <thead className="text-muted">
                <tr className="border-b border-hairline">
                  <th className="sticky top-0 z-10 bg-canvas px-3 py-2 font-medium">
                    日期
                  </th>
                  <th className="sticky top-0 z-10 bg-canvas px-3 py-2 text-right font-medium">
                    输入 Token
                  </th>
                  <th className="sticky top-0 z-10 bg-canvas px-3 py-2 text-right font-medium">
                    输出 Token
                  </th>
                  <th className="sticky top-0 z-10 bg-canvas px-3 py-2 text-right font-medium">
                    总计
                  </th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((row) => (
                  <tr
                    key={row.date}
                    className="border-b border-hairline/50 transition-colors last:border-0 hover:bg-surface-card"
                  >
                    <td className="px-3 py-2 font-mono text-muted">
                      {row.date}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatCompactNumber(row.input_tokens)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatCompactNumber(row.output_tokens)}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">
                      {formatCompactNumber(row.total_tokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function TelemetryPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex h-8 items-center justify-between gap-2 rounded-lg border border-hairline bg-canvas px-3">
      <span>{label}</span>
      <span className="font-semibold tabular-nums text-ink">{value}</span>
    </span>
  );
}


/**
 * 运行时基础设施面板：本地 agent-runtime 子进程、IPC 监听器、队列深度、
 * runtime 心跳与全局并发闸门的实时快照。用于主动发现「账号级 runtime 掉线 /
 * 队列堆积 / 监听器泄漏」这类过去只能靠翻日志发现的问题。
 */
function RuntimeInfraPanel({ runtime }: { runtime: AdminRuntimeStatus }) {
  const staleQueues = runtime.queues.filter((queue) => queue.depth >= 3);
  return (
    <section className="rounded-xl border border-hairline bg-surface-card p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[14px] font-semibold">
            <Cpu size={15} className="text-muted" />
            运行时基础设施
          </div>
          <div className="mt-1 text-[12px] text-muted">
            agent-runtime 子进程 / IPC 监听 / 队列 / 心跳 / 并发闸门
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          <TelemetryPill
            label="在跑请求"
            value={String(
              runtime.ipc.pendingAiChatCount + runtime.ipc.pendingInboxCount,
            )}
          />
          <TelemetryPill
            label="并发槽"
            value={`${runtime.concurrency.activeSlots} 活跃 / ${
              runtime.concurrency.memberWaiters +
              runtime.concurrency.normalWaiters
            } 排队`}
          />
          <TelemetryPill
            label="监听器"
            value={`${runtime.ipc.listenerAccounts.length}（常驻 ${runtime.ipc.pinnedListenerCount}）`}
          />
        </div>
      </div>

      {staleQueues.length > 0 && (
        <div className="mb-3">
          <AdminAlert tone="error">
            检测到 {staleQueues.length} 个队列存在堆积（
            {staleQueues
              .slice(0, 3)
              .map((queue) => `${queue.key}×${queue.depth}`)
              .join('、')}
            {staleQueues.length > 3 ? ' 等' : ''}
            ）。若持续不消退，说明对应 runtime 停止消费。
          </AdminAlert>
        </div>
      )}

      {runtime.localAgents.length === 0 ? (
        <AdminEmptyState
          icon={Cpu}
          title="当前没有运行中的 agent-runtime 子进程"
          description="有用户发起 AI 对话后，这里会展示每个账号的常驻子进程与心跳"
        />
      ) : (
        <div className="max-h-72 overflow-auto rounded-lg border border-hairline bg-canvas">
          <table className="w-full min-w-[560px] text-left text-[12px]">
            <thead className="text-muted">
              <tr className="border-b border-hairline">
                <th className="sticky top-0 z-10 bg-canvas px-3 py-2 font-medium">
                  账号
                </th>
                <th className="sticky top-0 z-10 bg-canvas px-3 py-2 text-right font-medium">
                  PID
                </th>
                <th className="sticky top-0 z-10 bg-canvas px-3 py-2 text-right font-medium">
                  在途请求
                </th>
                <th className="sticky top-0 z-10 bg-canvas px-3 py-2 text-right font-medium">
                  心跳
                </th>
                <th className="sticky top-0 z-10 bg-canvas px-3 py-2 text-right font-medium">
                  状态
                </th>
              </tr>
            </thead>
            <tbody>
              {runtime.localAgents.map((agent) => {
                const hasHeartbeat = runtime.heartbeatAccounts.includes(
                  agent.accountId,
                );
                return (
                  <tr
                    key={agent.accountId}
                    className="border-b border-hairline last:border-b-0"
                  >
                    <td className="px-3 py-2 font-mono text-[11px]">
                      {agent.accountId}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {agent.pid ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {agent.busyCount}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {hasHeartbeat ? (
                        <span className="text-accent-teal">正常</span>
                      ) : (
                        <span className="text-primary">缺失</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {agent.stopping
                        ? '停止中'
                        : agent.alive
                          ? '运行中'
                          : '已退出'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * 渲染管理后台完整运行状态页。
 *
 * @returns 全站运行指标、处理队列和 Token 趋势视图。
 */
export default function AdminStatusPage() {
  const { toast } = useToast();
  const [stats, setStats] = useState<AdminStatusStats | null>(null);
  const [runtime, setRuntime] = useState<AdminRuntimeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  // 区分首屏加载与手动刷新：仅手动刷新才弹 toast，避免首屏自动加载打扰
  const manualRefreshRef = useRef(false);

  const fetchStats = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      // 并行拉取业务统计与运行时基础设施快照；后者失败不阻塞前者展示。
      const [statsResult, runtimeResult] = await Promise.allSettled([
        admin.status(),
        admin.runtimeStatus(),
      ]);
      if (statsResult.status === 'rejected') throw statsResult.reason;
      setStats(statsResult.value);
      setRuntime(
        runtimeResult.status === 'fulfilled' ? runtimeResult.value : null,
      );
      setUpdatedAt(new Date());
      if (manualRefreshRef.current) toast('success', '运行状态已刷新');
    } catch (err) {
      const message = err instanceof Error ? err.message : '加载失败';
      setError(message);
      if (manualRefreshRef.current) toast('error', `刷新失败：${message}`);
    } finally {
      manualRefreshRef.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    void fetchStats();
  }, [fetchStats]);

  // 手动刷新：标记后复用 fetchStats，成功/失败都给 toast
  const handleManualRefresh = useCallback(() => {
    manualRefreshRef.current = true;
    void fetchStats();
  }, [fetchStats]);

  if (loading) {
    return <AdminLoadingState />;
  }

  if (error) {
    return (
      <div className="space-y-3 py-20">
        <AdminAlert tone="error">{error}</AdminAlert>
        <div className="text-center">
          <button
            onClick={handleManualRefresh}
            className="cursor-pointer text-[13px] text-muted hover:text-ink"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  if (!stats) return null;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <RadioTower size={16} className="text-muted" />
        <h2 className="text-lg font-semibold">运行状态</h2>
        <button
          onClick={handleManualRefresh}
          disabled={refreshing}
          className="cursor-pointer rounded-md p-1.5 text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          title="刷新"
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
        </button>
        {updatedAt && (
          <span className="text-[12px] text-muted">
            最后同步 {updatedAt.toLocaleTimeString('zh-CN', { hour12: false })}
          </span>
        )}
      </div>

      <div className="space-y-4">
        <section className="rounded-xl border border-hairline bg-surface-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-muted">
                Live Ops
              </div>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">
                完整运行指标
              </h1>
              <p className="mt-1 text-[13px] text-muted">
                公开状态页只展示服务可用性；业务规模、队列和消耗趋势仅在后台查看。
              </p>
            </div>
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-hairline bg-surface-cream-strong text-muted">
              <Activity size={20} />
            </div>
          </div>
        </section>

        <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
          <StatCard
            icon={<MessageSquareText size={16} />}
            label="今日对话数"
            code="Msg"
            value={formatCompactNumber(stats.today_messages)}
            caption="全站今日请求"
          />
          <StatCard
            icon={<RefreshCw size={16} />}
            label="正在处理会话"
            code="Run"
            value={formatCompactNumber(stats.processing_sessions)}
            caption="实时执行队列"
          />
          <StatCard
            icon={<Users size={16} />}
            label="注册用户数"
            code="Usr"
            value={formatCompactNumber(stats.registered_users)}
            caption="累计账户"
          />
          <StatCard
            icon={<Sparkles size={16} />}
            label="今日总 Token 消耗"
            code="Tok"
            value={formatCompactNumber(stats.today_total_tokens)}
            caption="输入 + 输出"
          />
        </div>

        {runtime && <RuntimeInfraPanel runtime={runtime} />}

        <TokenUsagePanel stats={stats} />
      </div>
    </>
  );
}
