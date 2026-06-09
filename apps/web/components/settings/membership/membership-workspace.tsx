'use client';

import { useState } from 'react';
import {
  Activity,
  Crown,
  Loader2,
  MessageSquare,
  RefreshCw,
  Sparkles,
  TrendingUp,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { billingApi } from '@/features/billing/api';
import { useMembershipOverview } from '@/features/billing/hooks/use-membership-overview';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { formatCoins } from '@/lib/soft-currency';
import { useConfirm } from '@/lib/use-confirm';
import type { BillingStatus } from '@/features/billing/api';

type MembershipStatus = BillingStatus['membership'];

function formatCompactNumber(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 1_000_000) {
    return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return `${(value / 1_000_000).toFixed(2).replace(/\.0+$/, '')}M`;
}

function membershipStatusText(status: MembershipStatus['allowance_status']) {
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
      return '本月额度已用完';
    case 'inactive':
    default:
      return '未开通';
  }
}

function resetText(value: string | null) {
  if (!value) return '开通后按月重置';
  return `${new Date(value).toLocaleDateString('zh-CN')} 重置`;
}

function progressPercent(ratio: number) {
  const percent = Math.min(100, Math.max(0, ratio * 100));
  if (percent > 0 && percent < 0.1) return 0.1;
  return Math.round(percent * 10) / 10;
}

function displayPercent(ratio: number) {
  const percent = Math.min(100, Math.max(0, ratio * 100));
  if (percent === 0) return '0%';
  if (percent < 0.01) return '< 0.01%';
  if (percent < 0.1) return `${percent.toFixed(2)}%`;
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

function userHandle(phoneLabel: string | null | undefined) {
  const compact = (phoneLabel || 'member').replace(/\s+/g, '');
  return `@${compact}`;
}

function activityCells(seed: number, percent: number) {
  const normalizedSeed = Math.max(1, Math.floor(seed));
  const activeCount = Math.min(
    14,
    Math.max(3, Math.ceil(Math.log10(normalizedSeed + 10) * 3)),
  );
  const alertCount = percent >= 95 ? 3 : percent >= 75 ? 2 : 1;

  return Array.from({ length: 72 }, (_, index) => {
    const hot = (index * 17 + normalizedSeed) % 53 < activeCount;
    const alert = (index * 11 + Math.round(percent)) % 47 < alertCount;
    return alert ? 'alert' : hot ? 'active' : 'idle';
  });
}

function AmpMetric({
  icon,
  label,
  value,
  tone = 'default',
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: 'default' | 'primary' | 'success' | 'warning';
}) {
  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'primary'
          ? 'text-primary'
          : 'text-ink';

  return (
    <div className="min-h-[78px] border-b border-r border-hairline/60 px-4 py-3 last:border-r-0 sm:min-h-[88px]">
      <div className="mb-2 flex items-center gap-2 text-[12px] text-muted">
        {icon}
        <span>{label}</span>
      </div>
      <div className={`text-[22px] font-extrabold tabular-nums ${toneClass}`}>
        {value}
      </div>
    </div>
  );
}

function AmpMembershipCard({
  membership,
  phoneLabel,
  todayMessages,
  todayTokens,
  monthlyTokens,
  monthlyCost,
  busy,
  refreshing,
  onSubscribe,
  onRefresh,
}: {
  membership: MembershipStatus;
  phoneLabel: string | null | undefined;
  todayMessages: number;
  todayTokens: number;
  monthlyTokens: number;
  monthlyCost: number;
  busy: boolean;
  refreshing: boolean;
  onSubscribe: () => void;
  onRefresh: () => void;
}) {
  const active = membership.active;
  const usedPercent = active
    ? progressPercent(membership.allowance_used_ratio)
    : 0;
  const usedPercentText = displayPercent(membership.allowance_used_ratio);
  const cells = activityCells(monthlyTokens + todayTokens + todayMessages, usedPercent);

  return (
    <section className="relative overflow-hidden rounded-lg border border-hairline bg-[color-mix(in_srgb,var(--color-canvas)_82%,var(--color-surface-card))] shadow-[0_24px_70px_color-mix(in_srgb,var(--color-accent-teal)_10%,transparent)]">
      <div
        className="pointer-events-none absolute inset-0 opacity-80"
        style={{
          backgroundImage:
            'linear-gradient(to right, color-mix(in srgb, var(--color-hairline) 62%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in srgb, var(--color-hairline) 62%, transparent) 1px, transparent 1px)',
          backgroundSize: '42px 42px',
        }}
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -right-24 top-14 h-72 w-72 rotate-12 rounded-[28px] border border-primary/20 opacity-45"
        style={{
          backgroundImage:
            'repeating-conic-gradient(from 20deg, color-mix(in srgb, var(--color-primary) 42%, transparent) 0deg 2deg, transparent 2deg 8deg), repeating-radial-gradient(circle, color-mix(in srgb, var(--color-accent-teal) 36%, transparent) 0 1px, transparent 1px 10px)',
          maskImage: 'radial-gradient(ellipse at center, black, transparent 72%)',
        }}
        aria-hidden="true"
      />

      <div className="relative z-10 flex min-h-16 items-center justify-between border-b border-hairline/70 px-5 sm:px-6">
        <div className="text-[22px] font-extrabold text-muted/35 sm:text-[26px]">
          FateClaw+
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-hairline bg-canvas/70 text-muted transition-colors hover:text-ink disabled:opacity-50"
          aria-label="刷新会员中心"
          title="刷新"
        >
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="relative z-10 grid border-b border-hairline/70 sm:grid-cols-[220px_minmax(0,1fr)]">
        <div className="border-b border-hairline/70 px-5 py-6 sm:border-b-0 sm:border-r sm:px-6">
          <div className="flex h-24 w-24 items-center justify-center rounded-full border border-hairline bg-[conic-gradient(from_160deg,color-mix(in_srgb,var(--color-accent-teal)_55%,var(--color-canvas)),color-mix(in_srgb,var(--color-primary)_55%,var(--color-canvas)),color-mix(in_srgb,var(--color-warning)_45%,var(--color-canvas)),color-mix(in_srgb,var(--color-accent-teal)_55%,var(--color-canvas)))] shadow-[0_10px_30px_color-mix(in_srgb,var(--color-primary)_18%,transparent)]">
            <Crown size={38} className="text-on-primary drop-shadow-sm" />
          </div>
          <div className="mt-5 text-[30px] font-extrabold leading-tight text-ink sm:text-[34px]">
            FateClaw Plus
          </div>
          <div className="mt-1 break-all font-mono text-[16px] font-semibold text-muted">
            {userHandle(phoneLabel)}
          </div>
          <button
            type="button"
            onClick={onSubscribe}
            disabled={busy || !membership.enabled}
            className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-[14px] font-semibold text-on-primary transition-colors hover:bg-primary-active disabled:opacity-40 sm:w-auto"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : null}
            {active ? '续费会员' : '开通会员'}
          </button>
        </div>

        <div className="grid min-h-[270px] content-between gap-6 px-5 py-6 sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="inline-flex min-h-8 items-center rounded-full border border-primary/25 bg-primary/8 px-3 text-[12px] font-semibold text-primary">
                {membershipStatusText(membership.allowance_status)}
              </div>
              <div className="mt-3 text-[13px] leading-6 text-muted">
                {formatCoins(membership.monthly_price_coins)} / 月 ·{' '}
                {active ? resetText(membership.allowance_reset_at) : '待开通'}
              </div>
            </div>
            <div className="text-left sm:text-right">
              <div className="text-[12px] text-muted">会员额度</div>
              <div className="mt-1 text-[28px] font-extrabold tabular-nums text-ink">
                {active ? usedPercentText : '--'}
              </div>
            </div>
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between gap-3 text-[12px] text-muted">
              <span>ACTIVITY</span>
              <span>{active ? '本月会员用量' : '等待开通'}</span>
            </div>
            <div className="grid grid-cols-12 gap-1" aria-hidden="true">
              {cells.map((state, index) => (
                <span
                  key={`${state}-${index}`}
                  className={`aspect-square min-w-0 border ${
                    state === 'alert'
                      ? 'border-primary/45 bg-primary/55'
                      : state === 'active'
                        ? 'border-accent-teal/35 bg-accent-teal/35'
                        : 'border-hairline/70 bg-canvas/35'
                  }`}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="relative z-10 grid grid-cols-2 overflow-hidden sm:grid-cols-4">
        <AmpMetric
          icon={<MessageSquare size={15} className="text-primary" />}
          label="今日消息"
          value={todayMessages.toLocaleString('zh-CN')}
          tone="default"
        />
        <AmpMetric
          icon={<Sparkles size={15} className="text-primary" />}
          label="今日 Token"
          value={formatCompactNumber(todayTokens)}
          tone="success"
        />
        <AmpMetric
          icon={<Activity size={15} className="text-primary" />}
          label="本月 Token"
          value={formatCompactNumber(monthlyTokens)}
          tone="primary"
        />
        <AmpMetric
          icon={<TrendingUp size={15} className="text-primary" />}
          label="本月消耗"
          value={formatCoins(monthlyCost)}
          tone="warning"
        />
      </div>
    </section>
  );
}

/**
 * 渲染会员中心页面。
 *
 * @returns 会员订阅和会员额度用量视图。
 */
export function MembershipWorkspace() {
  const { confirm } = useConfirm();
  const { user } = useAuth();
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
          <AmpMembershipCard
            membership={billingInfo.membership}
            phoneLabel={user?.phone_masked ?? user?.phone}
            todayMessages={todayMessages}
            todayTokens={todayTokens}
            monthlyTokens={monthlyTokens}
            monthlyCost={monthlyCost}
            busy={membershipBusy}
            refreshing={refreshing}
            onSubscribe={() => void handleSubscribeMembership()}
            onRefresh={() => void refresh()}
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
      </div>
    </AppShell>
  );
}
