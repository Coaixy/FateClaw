'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  MessageSquareText,
  RefreshCw,
  Sparkles,
  Users,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { billingApi, type PublicStatusStats } from '@/features/billing/api';

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
    <AppShell>
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
          <div className="grid gap-3 md:grid-cols-3">
            {[0, 1, 2].map((item) => (
              <div
                key={item}
                className="h-36 animate-pulse rounded-2xl border border-hairline bg-surface-card"
              />
            ))}
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            <StatusCard
              icon={<MessageSquareText size={18} />}
              label="今日对话数"
              value={formatCompactNumber(stats?.today_messages ?? 0)}
            />
            <StatusCard
              icon={<Users size={18} />}
              label="注册用户数"
              value={formatCompactNumber(stats?.registered_users ?? 0)}
            />
            <StatusCard
              icon={<Sparkles size={18} />}
              label="今日总 Token 消耗"
              value={formatCompactNumber(stats?.today_total_tokens ?? 0)}
            />
          </div>
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
    <section className="rounded-2xl border border-hairline bg-surface-card p-5 shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
      <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
        {icon}
      </div>
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div className="mt-2 text-3xl font-extrabold tracking-tight tabular-nums">
        {value}
      </div>
    </section>
  );
}
