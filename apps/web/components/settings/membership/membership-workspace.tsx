'use client';

import { useState } from 'react';
import {
  Loader2,
  MessageSquare,
  Sparkles,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { billingApi } from '@/features/billing/api';
import { useMembershipOverview } from '@/features/billing/hooks/use-membership-overview';
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

function activityTooltip(monthlyMessages: number, monthlyTokens: number) {
  return `本月消息 ${monthlyMessages.toLocaleString('zh-CN')} · 本月 Token ${formatCompactNumber(monthlyTokens)}`;
}

function formatMembershipDate(value: string | null) {
  if (!value) return '待开通';
  return new Date(value).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function formatMembershipUsage(monthlyMessages: number, monthlyTokens: number) {
  return `${monthlyMessages.toLocaleString('zh-CN')} 条 · ${formatCompactNumber(monthlyTokens)} Token`;
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
      return '额度已用完';
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
  if (percent > 0 && percent < 0.1) {
    return 0.1;
  }
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

function TaijiIcon({
  className = '',
  size = 1,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size * 24}
      height={size * 24}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M12 2a10 10 0 0 1 0 20c2.76 0 5-2.24 5-5s-2.24-5-5-5-5-2.24-5-5 2.24-5 5-5z"
        fill="currentColor"
      />
      <circle cx="12" cy="7.1" r="1.45" fill="var(--color-canvas)" />
      <circle cx="12" cy="16.9" r="1.45" fill="var(--color-primary)" />
    </svg>
  );
}

function shouldReduceMotion() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function setCardMotionVars(
  element: HTMLElement,
  vars: Record<string, string>,
) {
  for (const [key, value] of Object.entries(vars)) {
    element.style.setProperty(key, value);
  }
}

function handleCardPointerEnter(event: React.PointerEvent<HTMLElement>) {
  if (event.pointerType !== 'mouse' || shouldReduceMotion()) return;
  setCardMotionVars(event.currentTarget, {
    '--amp-lift': '-8px',
    '--amp-scale': '1.012',
  });
}

function handleCardPointerMove(event: React.PointerEvent<HTMLElement>) {
  if (event.pointerType !== 'mouse' || shouldReduceMotion()) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width - 0.5;
  const y = (event.clientY - rect.top) / rect.height - 0.5;

  setCardMotionVars(event.currentTarget, {
    '--amp-lift': '-8px',
    '--amp-scale': '1.012',
    '--amp-tilt-x': `${(-y * 8).toFixed(2)}deg`,
    '--amp-tilt-y': `${(x * 9).toFixed(2)}deg`,
    '--amp-glare-x': `${((x + 0.5) * 100).toFixed(1)}%`,
    '--amp-glare-y': `${((y + 0.5) * 100).toFixed(1)}%`,
  });
}

function handleCardPointerLeave(event: React.PointerEvent<HTMLElement>) {
  setCardMotionVars(event.currentTarget, {
    '--amp-lift': '0px',
    '--amp-scale': '1',
    '--amp-tilt-x': '0deg',
    '--amp-tilt-y': '0deg',
    '--amp-glare-x': '50%',
    '--amp-glare-y': '50%',
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
  monthlyMessages,
  monthlyTokens,
}: {
  monthlyMessages: number;
  monthlyTokens: number;
}) {
  const cells = activityCells(monthlyTokens + monthlyMessages, 100);
  const activityTip = activityTooltip(monthlyMessages, monthlyTokens);
  const terms = ['六爻', '八字', '紫微斗数', '奇门遁甲'] as const;

  return (
    <section
      className="group relative overflow-hidden rounded-lg border border-hairline bg-[color-mix(in_srgb,var(--color-canvas)_82%,var(--color-surface-card))] shadow-[0_24px_70px_color-mix(in_srgb,var(--color-accent-teal)_10%,transparent)] transition-[transform,box-shadow] duration-300 ease-out will-change-transform [transform:perspective(1200px)_rotateX(var(--amp-tilt-x,0deg))_rotateY(var(--amp-tilt-y,0deg))_translate3d(0,var(--amp-lift,0px),0)_scale(var(--amp-scale,1))] [transform-style:preserve-3d] hover:shadow-[0_36px_100px_color-mix(in_srgb,var(--color-accent-teal)_18%,transparent)] motion-reduce:transform-none motion-reduce:transition-none"
      onPointerEnter={handleCardPointerEnter}
      onPointerMove={handleCardPointerMove}
      onPointerLeave={handleCardPointerLeave}
      style={
        {
          '--amp-glare-x': '50%',
          '--amp-glare-y': '50%',
          '--amp-lift': '0px',
          '--amp-scale': '1',
          '--amp-tilt-x': '0deg',
          '--amp-tilt-y': '0deg',
        } as React.CSSProperties
      }
    >
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
      <div
        className="pointer-events-none absolute inset-0 z-[2] opacity-0 transition-opacity duration-300 group-hover:opacity-100 motion-reduce:hidden"
        style={{
          background:
            'radial-gradient(circle at var(--amp-glare-x) var(--amp-glare-y), color-mix(in srgb, var(--color-on-primary) 42%, transparent), transparent 38%)',
        }}
        aria-hidden="true"
      />

      <div className="relative z-10 flex min-h-14 items-center justify-between border-b border-hairline/70 px-5 [transform:translateZ(22px)] sm:min-h-16 sm:px-6">
        <div className="text-[22px] font-extrabold text-muted/35 sm:text-[26px]">
          FateClaw+
        </div>
      </div>

      <div className="relative z-10 grid border-b border-hairline/70 sm:grid-cols-[220px_minmax(0,1fr)]">
        <div className="border-b border-hairline/70 px-5 py-5 [transform:translateZ(28px)] sm:border-b-0 sm:border-r sm:px-6 sm:py-6">
          <div className="flex h-20 w-20 items-center justify-center rounded-full border border-hairline bg-[conic-gradient(from_160deg,color-mix(in_srgb,var(--color-accent-teal)_55%,var(--color-canvas)),color-mix(in_srgb,var(--color-primary)_55%,var(--color-canvas)),color-mix(in_srgb,var(--color-warning)_45%,var(--color-canvas)),color-mix(in_srgb,var(--color-accent-teal)_55%,var(--color-canvas)))] shadow-[0_10px_30px_color-mix(in_srgb,var(--color-primary)_18%,transparent)] transition-transform duration-300 group-hover:scale-[1.04] sm:h-24 sm:w-24">
            <TaijiIcon size={1.25} className="text-on-primary drop-shadow-sm" />
          </div>
          <div className="mt-4 text-[52px] font-extrabold leading-none text-ink sm:mt-5 sm:text-[64px]">
            Plus
          </div>
        </div>

        <div className="grid content-center gap-5 px-5 py-5 [transform:translateZ(18px)] sm:min-h-[270px] sm:gap-6 sm:px-6 sm:py-6">
          <div className="relative">
            <div className="mb-3 flex items-center justify-between gap-3 text-[12px] text-muted">
              <span>ACTIVITY</span>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
              {terms.map((term, index) => (
                <span
                  key={term}
                  className={`inline-flex min-h-8 items-center rounded-full border border-hairline bg-canvas/70 px-3 text-[12px] font-medium text-muted shadow-[0_6px_14px_color-mix(in_srgb,var(--color-ink)_6%,transparent)] transition-transform duration-300 ${
                    index % 2 === 0 ? '-rotate-2' : 'rotate-2'
                  }`}
                >
                  {term}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-12 gap-1">
              {cells.map((state, index) => {
                const stateLabel =
                  state === 'alert'
                    ? '高频活跃'
                    : state === 'active'
                      ? '持续活跃'
                      : '轻度活跃';
                return (
                  <span
                    key={`${state}-${index}`}
                    title={activityTip}
                    aria-label={`${activityTip} · ${stateLabel}`}
                    className={`aspect-square min-w-0 border ${index >= 48 ? 'hidden sm:block' : ''} ${
                      state === 'alert'
                        ? 'border-primary/45 bg-primary/55'
                        : state === 'active'
                          ? 'border-accent-teal/35 bg-accent-teal/35'
                          : 'border-hairline/70 bg-canvas/35'
                    }`}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="relative z-10 grid grid-cols-2 overflow-hidden [transform:translateZ(14px)]">
        <AmpMetric
          icon={<MessageSquare size={15} className="text-primary" />}
          label="本月消息"
          value={monthlyMessages.toLocaleString('zh-CN')}
          tone="default"
        />
        <AmpMetric
          icon={<Sparkles size={15} className="text-primary" />}
          label="本月 Token"
          value={formatCompactNumber(monthlyTokens)}
          tone="primary"
        />
      </div>
    </section>
  );
}

function FreeMembershipCard({
  availableCoins,
  monthlyMessages,
  monthlyTokens,
}: {
  availableCoins: number;
  monthlyMessages: number;
  monthlyTokens: number;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-hairline bg-[color-mix(in_srgb,var(--color-canvas)_88%,var(--color-surface-card))] shadow-[0_18px_54px_color-mix(in_srgb,var(--color-ink)_5%,transparent)]">
      <div className="grid border-b border-hairline/70 sm:grid-cols-[220px_minmax(0,1fr)]">
        <div className="border-b border-hairline/70 px-5 py-5 sm:border-b-0 sm:border-r sm:px-6 sm:py-6">
          <div className="flex h-20 w-20 items-center justify-center rounded-full border border-hairline bg-[conic-gradient(from_180deg,color-mix(in_srgb,var(--color-surface-card)_82%,var(--color-canvas)),color-mix(in_srgb,var(--color-accent-teal)_24%,var(--color-canvas)),color-mix(in_srgb,var(--color-primary)_22%,var(--color-canvas)),color-mix(in_srgb,var(--color-surface-card)_82%,var(--color-canvas)))] shadow-[0_10px_28px_color-mix(in_srgb,var(--color-ink)_6%,transparent)] sm:h-24 sm:w-24">
            <TaijiIcon size={1.25} className="text-muted/70" />
          </div>
          <div className="mt-4 text-[48px] font-extrabold leading-none text-ink sm:mt-5 sm:text-[60px]">
            Free
          </div>
        </div>

        <div className="grid content-center gap-4 px-5 py-5 sm:min-h-[220px] sm:px-6 sm:py-6">
          <div>
            <div className="text-[20px] font-semibold tracking-tight text-ink">
              当前为免费账户
            </div>
            <p className="mt-2 max-w-xl text-[12px] leading-6 text-muted sm:text-[13px]">
              未开通会员时，AI Chat 消耗会直接使用钱包余额；开通后会员额度会优先抵扣。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {['钱包余额计费', '可随时升级', '会员额度未启用'].map((item) => (
              <span
                key={item}
                className="inline-flex min-h-8 items-center rounded-full border border-hairline bg-surface-card/70 px-3 text-[12px] font-medium text-muted"
              >
                {item}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 overflow-hidden">
        <AmpMetric
          icon={<Sparkles size={15} className="text-primary" />}
          label="可用余额"
          value={formatCoins(availableCoins)}
          tone="primary"
        />
        <AmpMetric
          icon={<MessageSquare size={15} className="text-primary" />}
          label="本月消息"
          value={monthlyMessages.toLocaleString('zh-CN')}
          tone="default"
        />
        <AmpMetric
          icon={<Sparkles size={15} className="text-primary" />}
          label="本月 Token"
          value={formatCompactNumber(monthlyTokens)}
          tone="default"
        />
      </div>
    </section>
  );
}

function MembershipDetailPanel({
  membership,
  monthlyMessages,
  monthlyTokens,
  busy,
  onSubscribe,
}: {
  membership: MembershipStatus;
  monthlyMessages: number;
  monthlyTokens: number;
  busy: boolean;
  onSubscribe: () => void;
}) {
  const label = membership.active ? '续费会员' : '开通会员';
  const usedPercent = progressPercent(membership.allowance_used_ratio);
  const usedPercentText = displayPercent(membership.allowance_used_ratio);
  const detailItems = [
    {
      className: 'border-r border-hairline/70',
      label: '到期时间',
      value: formatMembershipDate(membership.current_period_end),
    },
    {
      className: 'sm:border-r sm:border-hairline/70',
      label: '本月用量',
      value: formatMembershipUsage(monthlyMessages, monthlyTokens),
    },
    {
      className: 'col-span-2 border-t border-hairline/70 sm:col-span-1 sm:border-t-0',
      label: '会员价格',
      value: `${formatCoins(membership.monthly_price_coins)} / 月`,
    },
  ] as const;
  const progressLabel = membership.active
    ? `${membershipStatusText(membership.allowance_status)} · 已使用 ${usedPercentText}`
    : '开通后显示额度进度';
  const progressValue = membership.active ? usedPercent : 0;

  return (
    <section
      aria-label="会员详情"
      className="-mt-1 overflow-hidden rounded-lg border border-hairline bg-surface-card shadow-[0_10px_24px_color-mix(in_srgb,var(--color-ink)_7%,transparent)]"
    >
      <div className="grid sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <div className="grid grid-cols-2 sm:grid-cols-3">
            {detailItems.map((item) => (
              <div
                key={item.label}
                className={`min-w-0 px-3 py-3 sm:px-4 ${item.className}`}
              >
                <div className="text-[11px] font-medium text-muted">
                  {item.label}
                </div>
                <div className="mt-1 min-h-5 whitespace-nowrap text-[13px] font-semibold leading-5 text-ink">
                  {item.value}
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-hairline/70 py-3 pl-14 pr-3 sm:px-4">
            <div className="mb-2 flex items-center justify-between gap-3 text-[12px] leading-5">
              <span className="font-medium text-muted">额度进度</span>
              <span className="min-w-0 text-right text-ink">
                {progressLabel}
              </span>
            </div>
            <div
              role="meter"
              aria-label="本月会员额度用量"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressValue}
              className="h-2.5 overflow-hidden rounded-full border border-hairline/70 bg-canvas/55"
            >
              <div
                className="h-full rounded-full bg-[linear-gradient(90deg,var(--color-accent-teal),var(--color-primary))] transition-[width]"
                style={{ width: `${progressValue}%` }}
              />
            </div>
            <div className="mt-2 text-[11px] leading-5 text-muted">
              {membership.enabled
                ? membership.active
                  ? `${resetText(membership.allowance_reset_at)}；额度用完后继续使用钱包余额。`
                  : '开通后会员额度优先抵扣 AI Chat 消耗。'
                : 'Plus 暂未开放购买，当前仍按钱包余额扣费。'}
            </div>
          </div>
        </div>
        <div className="border-t border-hairline/70 p-3 sm:flex sm:items-center sm:border-l sm:border-t-0">
          <button
            type="button"
            onClick={onSubscribe}
            disabled={busy || !membership.enabled}
            aria-label={`${label} FateClaw Plus`}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary px-4 text-[14px] font-semibold text-on-primary transition-colors hover:bg-primary-active disabled:opacity-40 sm:w-[132px]"
          >
            {busy ? (
              <Loader2 size={15} className="shrink-0 animate-spin" />
            ) : (
              <Sparkles size={15} className="shrink-0" />
            )}
            {label}
          </button>
        </div>
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
  const {
    billingInfo,
    usage,
    loading,
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
        <div className="space-y-4 pt-5 sm:pt-6 lg:pt-0">
          <div className="h-[200px] rounded-2xl border border-hairline bg-surface-card animate-pulse" />
          <div className="h-[150px] rounded-2xl border border-hairline bg-surface-card animate-pulse" />
        </div>
      </AppShell>
    );
  }

  const monthlyTokens = billingInfo?.monthly_tokens_used ?? 0;
  const monthlyMessages = usage?.monthly_messages ?? 0;
  const availableCoins = billingInfo?.available_coins ?? 0;
  const membership = billingInfo?.membership;

  return (
    <AppShell>
      <div className="space-y-5 pt-5 sm:pt-6 lg:pt-0">
        <div className="hidden items-center justify-between gap-3 lg:flex">
          <h2 className="font-display text-base font-semibold tracking-tight">
            会员中心
          </h2>
        </div>

        {membership ? (
          membership.active ? (
            <AmpMembershipCard
              monthlyMessages={monthlyMessages}
              monthlyTokens={monthlyTokens}
            />
          ) : (
            <FreeMembershipCard
              availableCoins={availableCoins}
              monthlyMessages={monthlyMessages}
              monthlyTokens={monthlyTokens}
            />
          )
        ) : null}
        {membership ? (
          <MembershipDetailPanel
            membership={membership}
            monthlyMessages={monthlyMessages}
            monthlyTokens={monthlyTokens}
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
      </div>
    </AppShell>
  );
}
