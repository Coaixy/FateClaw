'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  Sparkles,
  Users,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { billingApi, type PublicStatusStats } from '@/features/billing/api';

type TokenUsagePoint = PublicStatusStats['token_usage_series'][number];

function formatCompactNumber(value: number): string {
  if (value < 10000) return value.toLocaleString('zh-CN');
  if (value < 100000000) {
    return `${(value / 10000).toFixed(1).replace(/\.0$/, '')} 万`;
  }
  return `${(value / 100000000).toFixed(2).replace(/\.0+$/, '')} 亿`;
}

export function StatusWorkspace() {
  const [stats, setStats] = useState<PublicStatusStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    setRefreshing(true);
    setError('');
    try {
      setStats(await billingApi.publicStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : '状态数据加载失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  return (
    <AppShell wide>
      <div className="min-h-[70vh] space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[12px] font-semibold text-primary">
              <Activity size={14} />
              运行状态
            </div>
            <h2 className="mt-1 text-xl font-semibold tracking-tight">
              今日平台状态
            </h2>
          </div>
          <button
            type="button"
            onClick={() => void load(false)}
            disabled={refreshing}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-hairline px-3 text-[12px] text-muted transition-colors hover:text-ink disabled:opacity-50"
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            刷新
          </button>
        </div>

        {error && (
          <div className="rounded-xl border border-error/30 bg-error/8 px-4 py-3 text-[12px] text-error">
            {error}
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-3">
            {[0, 1, 2, 3].map((item) => (
              <div
                key={item}
                className="h-24 animate-pulse rounded-xl border border-hairline bg-surface-card md:h-32"
              />
            ))}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-3">
              <StatusCard
                icon={<MessageSquareText size={16} />}
                label="今日对话数"
                value={formatCompactNumber(stats?.today_messages ?? 0)}
              />
              <StatusCard
                icon={<LoaderCircle size={16} />}
                label="正在处理会话"
                value={formatCompactNumber(stats?.processing_sessions ?? 0)}
              />
              <StatusCard
                icon={<Users size={16} />}
                label="注册用户数"
                value={formatCompactNumber(stats?.registered_users ?? 0)}
              />
              <StatusCard
                icon={<Sparkles size={16} />}
                label="今日总 Token 消耗"
                value={formatCompactNumber(stats?.today_total_tokens ?? 0)}
              />
            </div>
            <TokenUsagePanel stats={stats} />
          </>
        )}
      </div>
    </AppShell>
  );
}

function StatusCard({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <section className="rounded-xl border border-hairline bg-surface-card p-3 shadow-[0_10px_28px_rgba(15,23,42,0.04)] md:p-4">
      <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary md:h-9 md:w-9">
        {icon}
      </div>
      <div className="text-[11px] font-medium leading-4 text-muted md:text-[12px]">
        {label}
      </div>
      <div className="mt-1 text-xl font-extrabold tracking-tight tabular-nums md:text-2xl">
        {value}
      </div>
    </section>
  );
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

function TokenUsagePanel({ stats }: { stats: PublicStatusStats | null }) {
  const rows = stats?.token_usage_series ?? [];
  // 图表保留旧到新的趋势轴，表格按最新日期优先展示。
  const chartRows = sortTokenUsageByDate(rows, 'asc');
  const tableRows = sortTokenUsageByDate(rows, 'desc');
  const maxTokens = Math.max(1, ...chartRows.map((row) => row.total_tokens));

  return (
    <section className="rounded-xl border border-hairline bg-surface-card p-3 shadow-[0_10px_28px_rgba(15,23,42,0.04)] md:p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[13px] font-semibold">Token 消耗趋势</div>
          <div className="mt-0.5 text-[11px] text-muted">最近 7 天全站统计</div>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-primary" />
            输入
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-accent-teal" />
            输出
          </span>
        </div>
      </div>

      <div className="flex h-36 items-end gap-2 rounded-lg border border-hairline bg-canvas/45 px-2 pb-7 pt-3 md:h-48 md:gap-3 md:px-4">
        {chartRows.map((row) => {
          const totalHeight = Math.max(
            row.total_tokens > 0 ? 6 : 2,
            Math.round((row.total_tokens / maxTokens) * 100),
          );
          const inputRatio =
            row.total_tokens > 0 ? row.input_tokens / row.total_tokens : 0;
          return (
            <div
              key={row.date}
              className="relative flex h-full min-w-0 flex-1 items-end justify-center"
            >
              <div
                className="flex w-full max-w-9 flex-col-reverse overflow-hidden rounded-t-md bg-hairline/70"
                style={{ height: `${totalHeight}%` }}
                title={`${row.date}：${formatCompactNumber(row.total_tokens)} Token`}
              >
                <div
                  className="bg-primary"
                  style={{ height: `${Math.max(0, Math.round(inputRatio * 100))}%` }}
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

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[480px] text-left text-[11px]">
          <thead className="text-muted">
            <tr className="border-b border-hairline">
              <th className="py-2 font-medium">日期</th>
              <th className="py-2 text-right font-medium">输入 Token</th>
              <th className="py-2 text-right font-medium">输出 Token</th>
              <th className="py-2 text-right font-medium">总计</th>
            </tr>
          </thead>
          <tbody>
            {tableRows.map((row) => (
              <tr key={row.date} className="border-b border-hairline/50 last:border-0">
                <td className="py-2 font-mono text-muted">{row.date}</td>
                <td className="py-2 text-right tabular-nums">
                  {formatCompactNumber(row.input_tokens)}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {formatCompactNumber(row.output_tokens)}
                </td>
                <td className="py-2 text-right font-semibold tabular-nums">
                  {formatCompactNumber(row.total_tokens)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
