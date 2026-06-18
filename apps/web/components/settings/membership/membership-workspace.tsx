'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Crown,
  Loader2,
  MessageSquare,
  Sparkles,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { billingApi } from '@/features/billing/api';
import { useMembershipOverview } from '@/features/billing/hooks/use-membership-overview';
import {
  MEMBERSHIP_CLARITY_PLAN_KEY,
  normalizeMembershipPlanKey,
  resolveMembershipPlanDisplayName,
  resolveMembershipPlanRank,
  resolveMembershipPlanShortName,
} from '@/features/billing/membership-plans';
import { useI18n } from '@/lib/i18n';
import { formatCoins } from '@/lib/soft-currency';
import { useConfirm } from '@/lib/use-confirm';
import { useToast } from '@/lib/use-toast';
import type { BillingStatus } from '@/features/billing/api';

type MembershipStatus = BillingStatus['membership'];
type MembershipEntitlement = BillingStatus['membership_entitlements'][number];
type MembershipPlan = BillingStatus['membership_plans'][number];
type TranslationFn = (
  key: string,
  params?: Record<string, string | number>,
) => string;

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

function activityTooltip(
  monthlyMessages: number,
  monthlyTokens: number,
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string,
  t: TranslationFn,
) {
  return t('pages.membership.activityTooltip', {
    messages: formatNumber(monthlyMessages),
    tokens: formatCompactNumber(monthlyTokens),
  });
}

function formatMembershipDate(
  value: string | null,
  formatDate: (
    value: string | number | Date,
    options?: Intl.DateTimeFormatOptions,
  ) => string,
  t: TranslationFn,
) {
  if (!value) return t('pages.membership.notSubscribed');
  return formatDate(value, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function formatMembershipUsage(
  monthlyMessages: number,
  monthlyTokens: number,
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string,
  t: TranslationFn,
) {
  return t('pages.membership.usageLabel', {
    messages: formatNumber(monthlyMessages),
    tokens: formatCompactNumber(monthlyTokens),
  });
}

function membershipStatusText(
  status: MembershipStatus['allowance_status'],
  t: TranslationFn,
) {
  switch (status) {
    case 'plenty':
      return t('pages.membership.statusPlenty');
    case 'normal':
      return t('pages.membership.statusNormal');
    case 'tight':
      return t('pages.membership.statusTight');
    case 'almost_used':
      return t('pages.membership.statusAlmostUsed');
    case 'used_up':
      return t('pages.membership.statusUsedUp');
    case 'inactive':
    default:
      return t('pages.membership.statusInactive');
  }
}

function resetText(
  value: string | null,
  formatDate: (
    value: string | number | Date,
    options?: Intl.DateTimeFormatOptions,
  ) => string,
  t: TranslationFn,
) {
  if (!value) return t('pages.membership.resetPending');
  return t('pages.membership.resetAt', {
    date: formatDate(value, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }),
  });
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

function resolvePlanShortName(plan: Pick<MembershipPlan, 'name' | 'plan_key'>) {
  return resolveMembershipPlanShortName(plan);
}

function resolvePlanDisplayName(
  plan: Pick<MembershipPlan, 'name' | 'plan_key'>,
) {
  return resolveMembershipPlanDisplayName(plan);
}

function resolveEntitlementShortName(
  entitlement: Pick<MembershipEntitlement, 'name' | 'plan_key'>,
) {
  return resolveMembershipPlanShortName(entitlement);
}

function hasMembershipAllowance(
  plan?: Pick<MembershipPlan, 'monthly_allowance_units'> | null,
) {
  return (plan?.monthly_allowance_units ?? 0) > 0;
}

function resolvePlanBenefitLabels(
  plan: Pick<MembershipPlan, 'name' | 'plan_key' | 'monthly_allowance_units'>,
  t: TranslationFn,
) {
  const planShortName = resolvePlanShortName(plan);
  if (planShortName === 'Clarity') {
    return [
      t('pages.membership.planBenefitClarityExpert'),
      t('pages.membership.planBenefitClarityDaily'),
      t('pages.membership.planBenefitClarityCharting'),
    ];
  }
  if (planShortName === 'Deep') {
    return [
      t('pages.membership.planBenefitDeepAllowance'),
      t('pages.membership.planBenefitDeepSupport'),
      t('pages.membership.planBenefitDeepExpert'),
    ];
  }
  return [
    t('pages.membership.planBenefitInsightExpert'),
    t('pages.membership.planBenefitInsightTools'),
    hasMembershipAllowance(plan)
      ? t('pages.membership.planBenefitInsightAllowance')
      : t('pages.membership.planBenefitNoAllowance'),
  ];
}

function formatEntitlementRange(
  entitlement: MembershipEntitlement,
  formatDate: (
    value: string | number | Date,
    options?: Intl.DateTimeFormatOptions,
  ) => string,
) {
  const options = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  } as const;
  return `${formatDate(entitlement.effective_start, options)} - ${formatDate(
    entitlement.effective_end,
    options,
  )}`;
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

function setCardMotionVars(element: HTMLElement, vars: Record<string, string>) {
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
  planShortName,
  monthlyMessages,
  monthlyTokens,
  formatNumber,
  t,
}: {
  planShortName: string;
  monthlyMessages: number;
  monthlyTokens: number;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  t: TranslationFn;
}) {
  const cells = activityCells(monthlyTokens + monthlyMessages, 100);
  const activityTip = activityTooltip(
    monthlyMessages,
    monthlyTokens,
    formatNumber,
    t,
  );
  const terms = [
    t('pages.membership.termsLiuYao'),
    t('pages.membership.termsBazi'),
    t('pages.membership.termsZiwei'),
    t('pages.membership.termsQimen'),
  ] as const;

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
          maskImage:
            'radial-gradient(ellipse at center, black, transparent 72%)',
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
            {planShortName}
          </div>
        </div>

        <div className="grid content-center gap-5 px-5 py-5 [transform:translateZ(18px)] sm:min-h-[270px] sm:gap-6 sm:px-6 sm:py-6">
          <div className="relative">
            <div className="mb-3 flex items-center justify-between gap-3 text-[12px] text-muted">
              <span>{t('pages.membership.activity')}</span>
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
                    ? t('pages.membership.highActivity')
                    : state === 'active'
                      ? t('pages.membership.sustainedActivity')
                      : t('pages.membership.lightActivity');
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
          label={t('pages.membership.monthlyMessages')}
          value={formatNumber(monthlyMessages)}
          tone="default"
        />
        <AmpMetric
          icon={<Sparkles size={15} className="text-primary" />}
          label={t('pages.membership.monthlyToken')}
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
  formatNumber,
  locale,
  t,
}: {
  availableCoins: number;
  monthlyMessages: number;
  monthlyTokens: number;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  locale: Parameters<typeof formatCoins>[1];
  t: TranslationFn;
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
              {t('pages.membership.freeAccount')}
            </div>
            <p className="mt-2 max-w-xl text-[12px] leading-6 text-muted sm:text-[13px]">
              {t('pages.membership.freeDescription')}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              t('pages.membership.freeBadgeWallet'),
              t('pages.membership.freeBadgeUpgrade'),
              t('pages.membership.freeBadgeInactive'),
            ].map((item) => (
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
          label={t('pages.membership.availableBalance')}
          value={formatCoins(availableCoins, locale)}
          tone="primary"
        />
        <AmpMetric
          icon={<MessageSquare size={15} className="text-primary" />}
          label={t('pages.membership.monthlyMessages')}
          value={formatNumber(monthlyMessages)}
          tone="default"
        />
        <AmpMetric
          icon={<Sparkles size={15} className="text-primary" />}
          label={t('pages.membership.monthlyToken')}
          value={formatCompactNumber(monthlyTokens)}
          tone="default"
        />
      </div>
    </section>
  );
}

function MembershipPlanCards({
  plans,
  activePlanKey,
  busyPlanKey,
  locale,
  onSubscribe,
  t,
}: {
  plans: MembershipPlan[];
  activePlanKey: string | null;
  busyPlanKey: string | null;
  locale: Parameters<typeof formatCoins>[1];
  onSubscribe: (plan: MembershipPlan) => void;
  t: TranslationFn;
}) {
  const scrollRef = useRef<HTMLElement | null>(null);
  const [planNavState, setPlanNavState] = useState({
    activeIndex: 0,
    canScrollNext: false,
    canScrollPrevious: false,
  });
  const normalizedActivePlanKey = activePlanKey
    ? normalizeMembershipPlanKey(activePlanKey)
    : null;
  const activePlanRank = resolveMembershipPlanRank(normalizedActivePlanKey);
  const visiblePlans = plans.filter((plan) => {
    if (activePlanRank <= 0) return true;
    return resolveMembershipPlanRank(plan.plan_key) > activePlanRank;
  });
  const visiblePlanSignature = visiblePlans
    .map((plan) => normalizeMembershipPlanKey(plan.plan_key))
    .join('|');

  const updatePlanNavState = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    const cards = Array.from(
      scroller.querySelectorAll<HTMLElement>('[data-plan-key]'),
    );
    const maxScrollLeft = Math.max(
      0,
      scroller.scrollWidth - scroller.clientWidth,
    );
    const scrollerRect = scroller.getBoundingClientRect();
    const viewportCenter = scrollerRect.left + scrollerRect.width / 2;
    const activeIndex =
      cards.length === 0
        ? 0
        : cards.reduce((closestIndex, card, index) => {
            const closestCard = cards[closestIndex];
            const closestCenter =
              closestCard.getBoundingClientRect().left +
              closestCard.offsetWidth / 2;
            const cardCenter =
              card.getBoundingClientRect().left + card.offsetWidth / 2;
            return Math.abs(cardCenter - viewportCenter) <
              Math.abs(closestCenter - viewportCenter)
              ? index
              : closestIndex;
          }, 0);
    const nextState = {
      activeIndex,
      canScrollNext: scroller.scrollLeft < maxScrollLeft - 2,
      canScrollPrevious: scroller.scrollLeft > 2,
    };

    setPlanNavState((currentState) =>
      currentState.activeIndex === nextState.activeIndex &&
      currentState.canScrollNext === nextState.canScrollNext &&
      currentState.canScrollPrevious === nextState.canScrollPrevious
        ? currentState
        : nextState,
    );
  }, []);

  useEffect(() => {
    if (!normalizedActivePlanKey || !scrollRef.current) return;
    const activeCard = Array.from(
      scrollRef.current.querySelectorAll<HTMLElement>('[data-plan-key]'),
    ).find((card) => card.dataset.planKey === normalizedActivePlanKey);
    if (!activeCard) return;
    scrollRef.current.scrollTo({
      left: activeCard.offsetLeft - scrollRef.current.offsetLeft,
      behavior: 'auto',
    });
    window.requestAnimationFrame(updatePlanNavState);
  }, [normalizedActivePlanKey, updatePlanNavState, visiblePlanSignature]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    updatePlanNavState();
    const handleScroll = () => updatePlanNavState();
    const handleResize = () => updatePlanNavState();
    scroller.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleResize);
    return () => {
      scroller.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleResize);
    };
  }, [updatePlanNavState, visiblePlanSignature]);

  const scrollPlanCards = (direction: 'previous' | 'next') => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    const delta = Math.max(280, scroller.clientWidth * 0.86);
    scroller.scrollBy({
      left: direction === 'previous' ? -delta : delta,
      behavior: 'smooth',
    });
    window.setTimeout(updatePlanNavState, 360);
  };

  if (visiblePlans.length === 0) return null;

  return (
    <div className="space-y-2">
      {visiblePlans.length > 1 && (
        <div className="flex items-center justify-end gap-2 px-1">
          <div className="flex items-center gap-1" aria-hidden="true">
            {visiblePlans.map((plan, index) => (
              <span
                key={plan.plan_key}
                className={`h-1.5 rounded-full transition-all ${
                  planNavState.activeIndex === index
                    ? 'w-5 bg-primary'
                    : 'w-1.5 bg-hairline'
                }`}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => scrollPlanCards('previous')}
            disabled={!planNavState.canScrollPrevious}
            aria-label={t('pages.membership.previousPlan')}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-hairline bg-surface-card text-muted shadow-sm transition-colors hover:bg-surface-cream-strong hover:text-ink disabled:cursor-default disabled:opacity-35"
          >
            <ChevronLeft size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => scrollPlanCards('next')}
            disabled={!planNavState.canScrollNext}
            aria-label={t('pages.membership.nextPlan')}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-hairline bg-surface-card text-muted shadow-sm transition-colors hover:bg-surface-cream-strong hover:text-ink disabled:cursor-default disabled:opacity-35"
          >
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </div>
      )}
      <section
        ref={scrollRef}
        aria-label={t('pages.membership.planCardsAria')}
        className="scrollbar-hide -mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-1 pb-1"
      >
        {visiblePlans.map((plan) => {
          const normalizedPlanKey = normalizeMembershipPlanKey(plan.plan_key);
          const isCurrentPlan = normalizedActivePlanKey === normalizedPlanKey;
          const busy = busyPlanKey === plan.plan_key;
          const planShortName = resolvePlanShortName(plan);
          const planDisplayName = resolvePlanDisplayName(plan);
          const benefitLabels = resolvePlanBenefitLabels(plan, t);
          const actionLabel = isCurrentPlan
            ? t('pages.membership.renewPlan', { plan: planShortName })
            : t('pages.membership.subscribePlan', { plan: planShortName });
          const buttonLabel = !plan.enabled
            ? t('pages.membership.planDisabled')
            : actionLabel;
          const buttonDisabled = busy || !plan.enabled;

          return (
            <article
              key={plan.plan_key}
              data-plan-key={normalizedPlanKey}
              className={`flex w-[min(82vw,360px)] shrink-0 snap-start flex-col overflow-hidden rounded-lg border bg-surface-card shadow-[0_10px_24px_color-mix(in_srgb,var(--color-ink)_6%,transparent)] sm:w-[360px] lg:w-[340px] ${
                isCurrentPlan ? 'border-primary/45' : 'border-hairline'
              }`}
            >
              <div className="flex min-h-[146px] flex-1 flex-col justify-between gap-4 p-4 sm:p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Crown size={16} className="shrink-0 text-primary" />
                      <h3 className="text-[18px] font-extrabold leading-tight text-ink">
                        {planDisplayName}
                      </h3>
                    </div>
                    <div className="mt-2 flex flex-wrap items-baseline gap-2">
                      <span className="text-[30px] font-extrabold leading-none text-ink tabular-nums">
                        {formatCoins(plan.monthly_price_coins, locale)}
                      </span>
                      <span className="text-[12px] font-medium text-muted">
                        {t('pages.membership.perMonth')}
                      </span>
                      {plan.display_price_coins > plan.monthly_price_coins && (
                        <span className="text-[12px] text-muted-soft line-through">
                          {formatCoins(plan.display_price_coins, locale)}
                        </span>
                      )}
                    </div>
                  </div>
                  {isCurrentPlan && (
                    <span className="inline-flex min-h-7 shrink-0 items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-2 text-[11px] font-semibold text-primary">
                      <CheckCircle2 size={12} aria-hidden="true" />
                      {t('pages.membership.currentPlan')}
                    </span>
                  )}
                </div>

                <div className="grid gap-2">
                  {benefitLabels.map((benefit) => (
                    <div
                      key={benefit}
                      className="flex min-h-6 items-center gap-2 text-[12px] leading-5 text-muted"
                    >
                      <CheckCircle2
                        size={13}
                        aria-hidden="true"
                        className="shrink-0 text-accent-teal"
                      />
                      <span>{benefit}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="shrink-0 border-t border-hairline/70 p-3">
                <button
                  type="button"
                  onClick={() => onSubscribe(plan)}
                  disabled={buttonDisabled}
                  aria-label={buttonLabel}
                  className={`inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md px-4 text-[14px] font-semibold transition-colors ${
                    isCurrentPlan
                      ? 'border border-primary/25 bg-primary/10 text-primary hover:bg-primary/15'
                      : 'bg-primary text-on-primary hover:bg-primary-active disabled:opacity-40'
                  }`}
                >
                  {busy ? (
                    <Loader2 size={15} className="shrink-0 animate-spin" />
                  ) : (
                    <Sparkles size={15} className="shrink-0" />
                  )}
                  {buttonLabel}
                </button>
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}

function MembershipDetailPanel({
  membership,
  entitlements,
  currentPlan,
  busyPlanKey,
  monthlyMessages,
  monthlyTokens,
  formatDate,
  formatNumber,
  locale,
  onRenew,
  t,
}: {
  membership: MembershipStatus;
  entitlements: MembershipEntitlement[];
  currentPlan: MembershipPlan | null;
  busyPlanKey: string | null;
  monthlyMessages: number;
  monthlyTokens: number;
  formatDate: (
    value: string | number | Date,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  locale: Parameters<typeof formatCoins>[1];
  onRenew: (plan: MembershipPlan) => void;
  t: TranslationFn;
}) {
  const usedPercent = progressPercent(membership.allowance_used_ratio);
  const usedPercentText = displayPercent(membership.allowance_used_ratio);
  const allowanceEnabled = hasMembershipAllowance(currentPlan);
  const detailItems = [
    {
      className: 'border-b border-hairline/70 sm:border-b-0 sm:border-r',
      label: t('pages.membership.expiresAt'),
      value: formatMembershipDate(membership.current_period_end, formatDate, t),
    },
    {
      className: 'border-b border-hairline/70 sm:border-b-0 sm:border-r',
      label: t('pages.membership.monthlyUsage'),
      value: formatMembershipUsage(
        monthlyMessages,
        monthlyTokens,
        formatNumber,
        t,
      ),
    },
    {
      className: '',
      label: t('pages.membership.membershipPrice'),
      value: t('pages.membership.pricePerMonth', {
        price: formatCoins(membership.monthly_price_coins, locale),
      }),
    },
  ] as const;
  const progressLabel = membership.active
    ? allowanceEnabled
      ? `${membershipStatusText(membership.allowance_status, t)} · ${t(
          'pages.membership.usedPercent',
          { percent: usedPercentText },
        )}`
      : t('pages.membership.noAllowanceStatus')
    : t('pages.membership.progressAfterSubscribe');
  const progressValue = membership.active && allowanceEnabled ? usedPercent : 0;
  const futureEntitlements = entitlements.filter(
    (entitlement) => !entitlement.is_current,
  );
  const nextEntitlement = futureEntitlements[0] ?? null;

  return (
    <section
      aria-label={t('pages.membership.detailAria')}
      className="-mt-1 overflow-hidden rounded-lg border border-hairline bg-surface-card shadow-[0_10px_24px_color-mix(in_srgb,var(--color-ink)_7%,transparent)]"
    >
      <div className="grid sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <div className="grid sm:grid-cols-3">
            {detailItems.map((item) => (
              <div
                key={item.label}
                className={`min-w-0 px-3 py-3 sm:px-4 ${item.className}`}
              >
                <div className="text-[11px] font-medium text-muted">
                  {item.label}
                </div>
                <div className="mt-1 min-h-5 break-words text-[13px] font-semibold leading-5 text-ink sm:whitespace-nowrap">
                  {item.value}
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-hairline/70 px-3 py-3 sm:px-4">
            <div className="mb-2 flex flex-col gap-1 text-[12px] leading-5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <span className="font-medium text-muted">
                {allowanceEnabled
                  ? t('pages.membership.allowanceProgress')
                  : t('pages.membership.noAllowanceProgress')}
              </span>
              <span className="min-w-0 text-ink sm:text-right">
                {progressLabel}
              </span>
            </div>
            <div
              role="meter"
              aria-label={t('pages.membership.allowanceUsageAria')}
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
              {membership.active
                ? allowanceEnabled
                  ? t('pages.membership.activeHint', {
                      reset: resetText(
                        membership.allowance_reset_at,
                        formatDate,
                        t,
                      ),
                    })
                  : t('pages.membership.noAllowanceActiveHint')
                : membership.enabled
                  ? currentPlan && !allowanceEnabled
                    ? t('pages.membership.noAllowanceInactiveHint')
                    : t('pages.membership.inactiveHint')
                  : t('pages.membership.disabledHint')}
            </div>
          </div>
          {entitlements.length > 0 && (
            <div className="border-t border-hairline/70 px-3 py-3 sm:px-4">
              <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                <div className="text-[11px] font-medium text-muted">
                  {t('pages.membership.entitlementTimeline')}
                </div>
                {nextEntitlement && (
                  <div className="text-[11px] leading-5 text-muted sm:text-right">
                    {t('pages.membership.entitlementFallbackHint', {
                      plan: resolveEntitlementShortName(nextEntitlement),
                      date: formatMembershipDate(
                        nextEntitlement.effective_end,
                        formatDate,
                        t,
                      ),
                    })}
                  </div>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {entitlements.map((entitlement) => {
                  const planShortName =
                    resolveEntitlementShortName(entitlement);
                  const canRenewCurrentEntitlement = Boolean(
                    entitlement.is_current && currentPlan?.enabled,
                  );
                  const renewingCurrentPlan =
                    currentPlan?.plan_key === busyPlanKey;
                  return (
                    <div
                      key={`${entitlement.plan_key}-${entitlement.effective_start}-${entitlement.effective_end}`}
                      className={`rounded-md border px-3 py-2 ${
                        entitlement.is_current
                          ? 'border-primary/35 bg-primary/8'
                          : 'border-hairline bg-canvas/45'
                      }`}
                    >
                      <div className="flex min-h-5 items-center justify-between gap-2">
                        <span className="text-[12px] font-semibold text-ink">
                          {planShortName}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            entitlement.is_current
                              ? 'bg-primary/12 text-primary'
                              : 'bg-surface-card text-muted'
                          }`}
                        >
                          {entitlement.is_current
                            ? t('pages.membership.entitlementCurrent')
                            : t('pages.membership.entitlementUpcoming')}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] leading-5 text-muted">
                        {formatEntitlementRange(entitlement, formatDate)}
                      </div>
                      {canRenewCurrentEntitlement && currentPlan && (
                        <button
                          type="button"
                          onClick={() => onRenew(currentPlan)}
                          disabled={renewingCurrentPlan}
                          aria-label={t('pages.membership.renewPlan', {
                            plan: resolvePlanShortName(currentPlan),
                          })}
                          className="mt-2 inline-flex min-h-8 w-full items-center justify-center gap-1.5 rounded-md border border-primary/25 bg-primary/10 px-3 text-[12px] font-semibold text-primary transition-colors hover:bg-primary/15 disabled:cursor-wait disabled:opacity-70 sm:w-auto"
                        >
                          {renewingCurrentPlan ? (
                            <Loader2
                              size={13}
                              className="shrink-0 animate-spin"
                            />
                          ) : (
                            <Sparkles size={13} className="shrink-0" />
                          )}
                          {t('pages.membership.renewPlan', {
                            plan: resolvePlanShortName(currentPlan),
                          })}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * 渲染会员中心页面。
 *
 * @returns 会员订阅和会员免费额度用量视图。
 */
export function MembershipWorkspace() {
  const { confirm } = useConfirm();
  const { toast } = useToast();
  const { formatDate, formatNumber, locale, t } = useI18n();
  const { billingInfo, usage, loading, error, refresh } =
    useMembershipOverview();
  const [membershipBusyPlanKey, setMembershipBusyPlanKey] = useState<
    string | null
  >(null);

  const handleSubscribeMembership = async (plan: MembershipPlan) => {
    const membership = billingInfo?.membership;
    if (!membership || membershipBusyPlanKey || !plan.enabled) return;

    const priceText = formatCoins(plan.monthly_price_coins, locale);
    const planShortName = resolvePlanShortName(plan);
    const isCurrentPlan =
      normalizeMembershipPlanKey(membership.plan_key) ===
      normalizeMembershipPlanKey(plan.plan_key);
    const ok = await confirm({
      title: isCurrentPlan
        ? t('pages.membership.confirmRenewTitle')
        : t('pages.membership.confirmSubscribeTitle'),
      message: isCurrentPlan
        ? t('pages.membership.confirmRenewPlanMessage', {
            plan: planShortName,
            price: priceText,
          })
        : t('pages.membership.confirmSubscribePlanMessage', {
            plan: planShortName,
            price: priceText,
          }),
      confirmLabel: isCurrentPlan
        ? t('pages.membership.confirmRenew')
        : t('pages.membership.confirmSubscribe'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;

    setMembershipBusyPlanKey(plan.plan_key);
    try {
      await billingApi.subscribeMembership({ plan_key: plan.plan_key });
      await refresh();
    } catch (err) {
      toast(
        'error',
        err instanceof Error
          ? err.message
          : t('pages.membership.subscribeFailed'),
      );
    } finally {
      setMembershipBusyPlanKey(null);
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
  const membershipEntitlements = billingInfo?.membership_entitlements ?? [];
  const membershipPlans = billingInfo?.membership_plans ?? [];
  const normalizedActivePlanKey =
    membership?.active && membership.plan_key
      ? normalizeMembershipPlanKey(membership.plan_key)
      : null;
  const activePlan = normalizedActivePlanKey
    ? (membershipPlans.find(
        (plan) =>
          normalizeMembershipPlanKey(plan.plan_key) === normalizedActivePlanKey,
      ) ?? null)
    : null;
  const defaultPlan =
    activePlan ??
    membershipPlans.find(
      (plan) =>
        normalizeMembershipPlanKey(plan.plan_key) ===
        MEMBERSHIP_CLARITY_PLAN_KEY,
    ) ??
    membershipPlans[0] ??
    null;
  const activePlanShortName = activePlan
    ? resolvePlanShortName(activePlan)
    : 'Clarity';

  return (
    <AppShell>
      <div className="space-y-5 pt-5 sm:pt-6 lg:pt-0">
        <div className="hidden items-center justify-between gap-3 lg:flex">
          <h2 className="font-display text-base font-semibold tracking-tight">
            {t('pages.membership.title')}
          </h2>
        </div>

        {membership ? (
          membership.active ? (
            <AmpMembershipCard
              planShortName={activePlanShortName}
              monthlyMessages={monthlyMessages}
              monthlyTokens={monthlyTokens}
              formatNumber={formatNumber}
              t={t}
            />
          ) : (
            <FreeMembershipCard
              availableCoins={availableCoins}
              monthlyMessages={monthlyMessages}
              monthlyTokens={monthlyTokens}
              formatNumber={formatNumber}
              locale={locale}
              t={t}
            />
          )
        ) : null}
        <MembershipPlanCards
          plans={membershipPlans}
          activePlanKey={membership?.active ? membership.plan_key : null}
          busyPlanKey={membershipBusyPlanKey}
          locale={locale}
          onSubscribe={(plan) => void handleSubscribeMembership(plan)}
          t={t}
        />
        {membership ? (
          <MembershipDetailPanel
            membership={membership}
            entitlements={membershipEntitlements}
            currentPlan={defaultPlan}
            busyPlanKey={membershipBusyPlanKey}
            monthlyMessages={monthlyMessages}
            monthlyTokens={monthlyTokens}
            formatDate={formatDate}
            formatNumber={formatNumber}
            locale={locale}
            onRenew={(plan) => void handleSubscribeMembership(plan)}
            t={t}
          />
        ) : null}

        {error && (
          <div className="rounded-xl border border-error/30 bg-error/8 px-4 py-3 text-[12px] text-error">
            {error}
          </div>
        )}
      </div>
    </AppShell>
  );
}
