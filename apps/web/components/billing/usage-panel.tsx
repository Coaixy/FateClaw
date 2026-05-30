'use client';

import Link from 'next/link';
import {
  MessageSquare,
  RefreshCw,
  Sparkles,
  Wallet,
  Settings2,
} from 'lucide-react';

import type { BillingStatus, UsageStats } from '@/features/billing/api';
import { formatCoins } from '@/lib/soft-currency';

function formatTokens(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 1_000_000)
    return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(value / 1_000_000).toFixed(2).replace(/\.0+$/, '')}M`;
}

export function UsagePanel({
  status,
  usage,
  refreshing,
  onRefresh,
  onNavigate,
}: {
  status: BillingStatus | null;
  usage: UsageStats | null;
  refreshing: boolean;
  onRefresh: () => void;
  onNavigate: () => void;
}) {
  if (!status) {
    return (
      <div className="px-4 py-6 text-center text-[11px] text-muted">
        加载中…
      </div>
    );
  }

  const used = status.monthly_tokens_used;
  const todayMessages = usage?.today_messages ?? 0;
  const todayTokens =
    (usage?.today_input_tokens ?? 0) + (usage?.today_output_tokens ?? 0);

  return (
    <div className="w-[300px]">
      <div className="px-4 pt-3 pb-2.5 border-b border-hairline/40">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold text-ink">
                计费概览
              </span>
            </div>
            <div className="text-[10px] text-muted mt-0.5">
              官方模型与自配模型平台服务费均按用量扣费
            </div>
          </div>
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="w-6 h-6 rounded-md flex items-center justify-center text-muted hover:text-ink hover:bg-surface-cream-strong transition-colors cursor-pointer disabled:opacity-50"
            aria-label="刷新"
          >
            <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="px-4 py-3 border-b border-hairline/40">
        <div className="flex items-center justify-between text-[10px] mb-1.5">
          <span className="text-muted uppercase tracking-wider font-semibold">
            本月 Token
          </span>
          <span className="tabular-nums text-ink font-medium">
            {formatTokens(used)}
          </span>
        </div>
        <div className="text-[10px] text-muted">
          本月已扣 {formatCoins(status.estimated_monthly_total_coins)}
        </div>
      </div>

      <div className="px-4 py-3 border-b border-hairline/40">
        <div className="text-[10px] text-muted uppercase tracking-wider font-semibold mb-2">
          今日使用
        </div>
        <div className="grid grid-cols-2 gap-2">
          <StatBox
            icon={MessageSquare}
            label="消息"
            value={`${todayMessages}`}
          />
          <StatBox
            icon={Sparkles}
            label="Token"
            value={formatTokens(todayTokens)}
          />
        </div>
      </div>

      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] text-muted uppercase tracking-wider font-semibold">
            账户余额
          </span>
          <span className="text-[14px] font-semibold tabular-nums text-ink">
            {formatCoins(status.available_coins)}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-1.5 text-center">
          <BalanceChip label="充值" value={status.purchased_coins} />
          <BalanceChip label="赠送" value={status.bonus_coins} />
        </div>
      </div>

      <div className="p-1.5 border-t border-hairline/40 flex gap-1">
        <Link
          href="/wallet"
          onClick={onNavigate}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[11px] font-medium text-muted hover:text-ink hover:bg-surface-cream-strong transition-colors"
        >
          <Wallet size={12} />
          钱包明细
        </Link>
        <Link
          href="/settings/advanced"
          onClick={onNavigate}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[11px] font-medium bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
        >
          <Settings2 size={12} />
          模型设置
        </Link>
      </div>
    </div>
  );
}

function StatBox({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof MessageSquare;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-hairline/40 bg-surface-card/40 px-2.5 py-2">
      <div className="flex items-center gap-1 text-[9px] text-muted uppercase tracking-wider">
        <Icon size={10} />
        {label}
      </div>
      <div className="text-[13px] font-semibold tabular-nums text-ink mt-0.5">
        {value}
      </div>
    </div>
  );
}

function BalanceChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-surface-card/50 border border-hairline/30 py-1.5">
      <div className="text-[9px] text-muted">{label}</div>
      <div className="text-[11px] font-medium tabular-nums text-ink mt-0.5">
        {formatCoins(value)}
      </div>
    </div>
  );
}
