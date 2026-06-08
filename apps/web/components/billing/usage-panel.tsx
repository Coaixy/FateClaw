'use client';

import Link from 'next/link';
import {
  Crown,
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

function membershipStatusText(status: BillingStatus['membership']['allowance_status']) {
  switch (status) {
    case 'plenty':
      return '额度充足';
    case 'normal':
      return '正常使用中';
    case 'tight':
      return '额度偏紧';
    case 'almost_used':
      return '即将用完';
    case 'used_up':
      return '本月已用完';
    case 'inactive':
    default:
      return '未开通';
  }
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
  const todayTokens = usage?.today_total_tokens ?? 0;
  const membership = status.membership;
  const membershipActive = membership.enabled && membership.active;

  return (
    <div className="mx-auto w-[min(340px,calc(100vw-1.5rem))]">
      <div className="border-b border-hairline/40 px-4 pb-3 pt-3.5">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-ink">
              计费概览
            </div>
            <div className="mt-1 max-w-[250px] text-[10px] leading-4 text-muted">
              官方模型与自配模型平台服务费均按用量扣费
            </div>
          </div>
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-cream-strong hover:text-ink disabled:opacity-50"
            aria-label="刷新"
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="space-y-3 p-3">
        <section className="rounded-lg border border-hairline/50 bg-canvas/50 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] font-medium text-muted">
              可用余额
            </span>
            <Wallet size={14} className="text-primary" />
          </div>
          <div className="mt-1 text-[20px] font-semibold leading-tight tabular-nums text-ink">
            {formatCoins(status.available_coins)}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <BalanceChip label="充值余额" value={status.purchased_coins} />
            <BalanceChip label="赠送余额" value={status.bonus_coins} />
          </div>
        </section>

        <div className="grid grid-cols-2 gap-2">
          <StatBox
            icon={MessageSquare}
            label="今日消息"
            value={`${todayMessages}`}
          />
          <StatBox
            icon={Sparkles}
            label="今日 Token"
            value={formatTokens(todayTokens)}
          />
        </div>

        <div className="rounded-lg border border-hairline/50 bg-surface-card/45 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] font-medium text-muted">
              本月 Token
            </span>
            <span className="text-[13px] font-semibold tabular-nums text-ink">
              {formatTokens(used)}
            </span>
          </div>
          <div className="mt-1 text-[10px] leading-4 text-muted">
            本月已扣 {formatCoins(status.estimated_monthly_total_coins)}
          </div>
        </div>

        <section className="rounded-lg border border-primary/20 bg-primary/8 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] font-semibold text-ink">
              FateClaw Plus
            </span>
            <Crown size={13} className="text-primary" />
          </div>
          <div className="mt-1 text-[10px] leading-4 text-muted">
            {membershipActive
              ? `会员额度 ${membershipStatusText(membership.allowance_status)}，用完后继续走钱包余额。`
              : membership.enabled
                ? '开通后会员额度先抵扣 AI Chat 消耗，并解锁微信 Claw。'
                : 'Plus 暂未开放购买，当前按钱包余额扣费。'}
          </div>
          {!membershipActive && membership.enabled ? (
            <Link
              href="/wallet"
              onClick={onNavigate}
              className="mt-2 inline-flex h-7 items-center justify-center gap-1.5 rounded-md bg-primary px-2.5 text-[10px] font-medium text-on-primary transition-colors hover:bg-primary-active"
            >
              <Crown size={11} />
              开通 Plus
            </Link>
          ) : null}
        </section>
      </div>

      <div className="grid grid-cols-2 gap-2 border-t border-hairline/40 p-2">
        <Link
          href="/wallet"
          onClick={onNavigate}
          className="flex h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-[11px] font-medium text-muted transition-colors hover:bg-surface-cream-strong hover:text-ink"
        >
          <Wallet size={12} />
          {membershipActive ? '钱包明细' : '充值 / Plus'}
        </Link>
        <Link
          href="/settings/advanced"
          onClick={onNavigate}
          className="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary/15 px-3 text-[11px] font-medium text-primary transition-colors hover:bg-primary/25"
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
    <div className="min-h-[64px] rounded-lg border border-hairline/50 bg-surface-card/45 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted">
        <Icon size={10} />
        {label}
      </div>
      <div className="mt-1 text-[16px] font-semibold leading-tight tabular-nums text-ink">
        {value}
      </div>
    </div>
  );
}

function BalanceChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-hairline/40 bg-surface-card/55 px-2.5 py-2 text-left">
      <div className="text-[10px] text-muted">{label}</div>
      <div className="mt-0.5 text-[12px] font-medium tabular-nums text-ink">
        {formatCoins(value)}
      </div>
    </div>
  );
}
