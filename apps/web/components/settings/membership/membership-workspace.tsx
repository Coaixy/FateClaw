'use client';

import { useState } from 'react';
import {
  Activity,
  MessageSquare,
  RefreshCw,
  Sparkles,
  TrendingUp,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { WalletMembershipCard } from '@/components/settings/wallet/wallet-membership-card';
import { WalletStatCard } from '@/components/settings/wallet/wallet-stat-card';
import { billingApi } from '@/features/billing/api';
import { useMembershipOverview } from '@/features/billing/hooks/use-membership-overview';
import { formatCoins } from '@/lib/soft-currency';
import { useConfirm } from '@/lib/use-confirm';

function formatCompactNumber(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 1_000_000) {
    return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return `${(value / 1_000_000).toFixed(2).replace(/\.0+$/, '')}M`;
}

/**
 * 渲染会员中心页面。
 *
 * @returns 会员订阅和会员额度用量视图。
 */
export function MembershipWorkspace() {
  const { confirm } = useConfirm();
  const {
    billingInfo,
    usage,
    loading,
    refreshing,
    error,
    refresh,
  } = useMembershipOverview();
  const [membershipBusy, setMembershipBusy] = useState(false);
  const [membershipError, setMembershipError] = useState<string | null>(null);

  const handleSubscribeMembership = async () => {
    const membership = billingInfo?.membership;
    if (!membership || membershipBusy || !membership.enabled) return;

    const priceText = formatCoins(membership.monthly_price_coins);
    const ok = await confirm({
      title: membership.active ? '确认续费会员' : '确认开通会员',
      message: membership.active
        ? `将从钱包余额扣除 ${priceText}，会员有效期将在当前周期结束后顺延 1 个月。`
        : `将从钱包余额扣除 ${priceText}，开通 FateClaw Plus 会员 1 个月。`,
      confirmLabel: membership.active ? '确认续费' : '确认开通',
      cancelLabel: '取消',
    });
    if (!ok) return;

    setMembershipBusy(true);
    setMembershipError(null);
    try {
      await billingApi.subscribeMembership();
      await refresh();
    } catch (err) {
      setMembershipError(err instanceof Error ? err.message : '开通会员失败');
    } finally {
      setMembershipBusy(false);
    }
  };

  if (loading) {
    return (
      <AppShell>
        <div className="space-y-4">
          <div className="h-[200px] rounded-2xl border border-hairline bg-surface-card animate-pulse" />
          <div className="h-[150px] rounded-2xl border border-hairline bg-surface-card animate-pulse" />
        </div>
      </AppShell>
    );
  }

  const monthlyTokens = billingInfo?.monthly_tokens_used ?? 0;
  const monthlyCost = billingInfo?.estimated_monthly_total_coins ?? 0;
  const todayMessages = usage?.today_messages ?? 0;
  const todayTokens = usage?.today_total_tokens ?? 0;

  return (
    <AppShell>
      <div className="space-y-5">
        <div className="hidden items-center justify-between gap-3 lg:flex">
          <h2 className="font-display text-base font-semibold tracking-tight">
            会员中心
          </h2>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-hairline bg-surface-card px-3 text-[12px] font-medium text-muted transition-colors hover:text-ink disabled:opacity-50"
          >
            <RefreshCw
              size={13}
              className={refreshing ? 'animate-spin' : ''}
            />
            刷新
          </button>
        </div>

        {billingInfo?.membership ? (
          <WalletMembershipCard
            membership={billingInfo.membership}
            busy={membershipBusy}
            onSubscribe={() => void handleSubscribeMembership()}
          />
        ) : null}

        {error && (
          <div className="rounded-xl border border-error/30 bg-error/8 px-4 py-3 text-[12px] text-error">
            {error}
          </div>
        )}
        {membershipError && (
          <div className="rounded-xl border border-error/30 bg-error/8 px-4 py-3 text-[12px] text-error">
            {membershipError}
          </div>
        )}

        <section className="rounded-2xl border border-hairline bg-surface-card p-4 sm:p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-[13px] font-semibold text-ink">会员用量</h3>
              <p className="mt-1 text-[11px] leading-5 text-muted">
                会员额度优先抵扣 AI Chat 消耗，额度用完后继续使用钱包余额。
              </p>
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-hairline bg-canvas/60 text-muted transition-colors hover:text-ink disabled:opacity-50 lg:hidden"
              aria-label="刷新会员用量"
            >
              <RefreshCw
                size={14}
                className={refreshing ? 'animate-spin' : ''}
              />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <WalletStatCard
              icon={<MessageSquare size={14} className="text-primary" />}
              label="今日消息"
              value={todayMessages.toLocaleString('zh-CN')}
            />
            <WalletStatCard
              icon={<Sparkles size={14} className="text-primary" />}
              label="今日 Token"
              value={formatCompactNumber(todayTokens)}
            />
            <WalletStatCard
              icon={<Activity size={14} className="text-primary" />}
              label="本月 Token"
              value={formatCompactNumber(monthlyTokens)}
            />
            <WalletStatCard
              icon={<TrendingUp size={14} className="text-primary" />}
              label="本月消耗"
              value={formatCoins(monthlyCost)}
            />
          </div>
        </section>
      </div>
    </AppShell>
  );
}
