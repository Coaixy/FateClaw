'use client';

import { useState } from 'react';
import {
  CheckCircle2,
  Crown,
  Info,
  Loader2,
  Sparkles,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { WalletBalanceCard } from '@/components/settings/wallet/wallet-balance-card';
import { WalletRechargePanel } from '@/components/settings/wallet/wallet-recharge-panel';
import { WalletTransactionsPanel } from '@/components/settings/wallet/wallet-transactions-panel';
import { billingApi } from '@/features/billing/api';
import { useMembershipOverview } from '@/features/billing/hooks/use-membership-overview';
import { useWalletOverview } from '@/features/billing/hooks/use-wallet-overview';
import {
  MEMBERSHIP_CLARITY_PLAN_KEY,
  normalizeMembershipPlanKey,
  resolveMembershipPlanDisplayName,
} from '@/features/billing/membership-plans';
import { useI18n } from '@/lib/i18n';
import { formatCoins } from '@/lib/soft-currency';
import { useConfirm } from '@/lib/use-confirm';
import { useToast } from '@/lib/use-toast';
import type { BillingStatus } from '@/features/billing/api';

type MembershipStatus = BillingStatus['membership'];
type MembershipPlan = BillingStatus['membership_plans'][number];
type TranslationFn = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/** 紧凑展示大额数字（Token 用 K/M 后缀），避免月额度区被长数字撑开。 */
function formatCompactNumber(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 1_000_000) {
    return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return `${(value / 1_000_000).toFixed(2).replace(/\.0+$/, '')}M`;
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

function resolvePlanDisplayName(
  plan: Pick<MembershipPlan, 'name' | 'plan_key'>,
) {
  // 优先使用后端配置的套餐名（如"卦师使用权"）；为空时回退到按档位推导的旧展示名。
  return plan.name?.trim() || resolveMembershipPlanDisplayName(plan);
}

function resolvePlanBenefitLabels(t: TranslationFn) {
  // 塌缩为单层"卦师使用权"：对比表逐行对应代码里的真实付费差异
  // （会员原价 vs 非会员 ×1.5、member/normal 双队列、BYOK 门禁、开放 API 门禁），
  // 不再宣传"人人都能用的功能"，把"为什么开会员"讲清楚。
  return [
    t('pages.membership.compareRowModelPrice'),
    t('pages.membership.compareRowQueue'),
    t('pages.membership.compareRowCustomModel'),
    t('pages.membership.compareRowOpenApi'),
  ];
}

/** 订阅卡内的单项指标（如月消息 / 月 Token）。 */
function SubscriptionMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-hairline/60 bg-canvas/50 px-3 py-2.5">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className="mt-1 text-[15px] font-bold tabular-nums text-ink">
        {value}
      </div>
    </div>
  );
}

/**
 * 会员 vs 非会员权益对比表。
 *
 * 行 = 权益维度；列 = 非会员 / 卦师使用权。非会员列如实展示现状
 * （×1.5 计费、排队靠后、两项不可用），让"开了会员到底差在哪"一眼可读。
 */
function MembershipCompareTable({
  rows,
  planName,
  t,
}: {
  rows: string[];
  planName: string;
  t: TranslationFn;
}) {
  // 列取值与 resolvePlanBenefitLabels 的行序一一对应。文案刻意保持短语，
  // 让三列在窄容器内也能放下而不出现横向滚动（细节差异由脚注补充说明）。
  const nonMemberValues = [
    t('pages.membership.compareNonMemberModelPrice'),
    t('pages.membership.compareNonMemberQueue'),
    t('pages.membership.compareNonMemberUnavailable'),
    t('pages.membership.compareNonMemberUnavailable'),
  ];
  const memberValues = [
    t('pages.membership.compareMemberModelPrice'),
    t('pages.membership.compareMemberQueue'),
    t('pages.membership.compareMemberAvailable'),
    t('pages.membership.compareMemberAvailable'),
  ];

  return (
    <div>
      <table className="w-full border-collapse text-left">
        <thead>
          <tr>
            <th
              scope="col"
              className="w-[38%] pb-2 pr-3 text-[11px] font-medium uppercase tracking-wider text-muted"
            >
              {t('pages.membership.compareColumnFeature')}
            </th>
            <th
              scope="col"
              className="pb-2 pr-3 text-[11px] font-medium uppercase tracking-wider text-muted"
            >
              {t('pages.membership.compareColumnNonMember')}
            </th>
            <th
              scope="col"
              className="pb-2 text-[11px] font-semibold uppercase tracking-wider text-primary"
            >
              {planName}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((feature, index) => (
            <tr key={feature} className="border-t border-hairline/50">
              <th
                scope="row"
                className="py-2.5 pr-3 align-top text-[12px] font-medium leading-5 text-ink"
              >
                {feature}
              </th>
              <td className="py-2.5 pr-3 align-top text-[12px] leading-5 text-muted">
                {nonMemberValues[index]}
              </td>
              {/* 第三列（会员）用 primary 底色整列强调，色块完全贴合单元格内缘，
                  不外扩，避免把表格撑出横向溢出。 */}
              <td className="relative py-2.5 align-top text-[12px] font-medium leading-5 text-ink">
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 inset-x-0 rounded-md bg-primary/6"
                />
                <span className="relative flex items-start gap-1.5">
                  <CheckCircle2
                    size={13}
                    aria-hidden="true"
                    className="mt-0.5 shrink-0 text-primary"
                  />
                  {memberValues[index]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* 表格下方补一行说明：功能本身人人可用，会员差异在价格与优先级——避免误读为"功能被锁"。 */}
      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-5 text-muted/80">
        <Info size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-muted/50" />
        {t('pages.membership.compareFootnote')}
      </p>
    </div>
  );
}

/**
 * 去游戏化后的订阅卡：展示当前套餐名、续费/到期日期、月额度与开通/续费按钮。
 *
 * @param props.plan 当前在售（或生效中）的套餐；为空时不渲染。
 * @param props.membership 当前会员状态，用于判断有效性与到期日。
 * @param props.monthlyMessages 本月消息数。
 * @param props.monthlyTokens 本月 Token 数。
 * @param props.busy 是否正在提交订阅/续费请求。
 * @param props.onSubscribe 点击开通/续费时的回调。
 * @returns 简洁的订阅信息面板。
 */
function SubscriptionCard({
  plan,
  membership,
  monthlyMessages,
  monthlyTokens,
  busy,
  formatDate,
  formatNumber,
  locale,
  onSubscribe,
  t,
}: {
  plan: MembershipPlan;
  membership: MembershipStatus | null | undefined;
  monthlyMessages: number;
  monthlyTokens: number;
  busy: boolean;
  formatDate: (
    value: string | number | Date,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  locale: Parameters<typeof formatCoins>[1];
  onSubscribe: (plan: MembershipPlan) => void;
  t: TranslationFn;
}) {
  const isActive = Boolean(membership?.active);
  const planDisplayName = resolvePlanDisplayName(plan);
  // 续费/开通文案：会员仍有效即视为续费（存量旧档 plan_key 不参与判断）。
  const actionLabel = isActive
    ? t('pages.membership.renewPlan', { plan: planDisplayName })
    : t('pages.membership.subscribePlan', { plan: planDisplayName });
  const buttonLabel = !plan.enabled
    ? t('pages.membership.planDisabled')
    : actionLabel;
  const buttonDisabled = busy || !plan.enabled;
  const dateValue = formatMembershipDate(
    membership?.current_period_end ?? null,
    formatDate,
    t,
  );

  return (
    <section className="overflow-hidden rounded-2xl border border-hairline bg-surface-raised shadow-raised">
      <div className="border-b border-hairline/60 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Crown size={16} className="shrink-0 text-primary" />
              <h3 className="text-[18px] font-extrabold leading-tight text-ink">
                {planDisplayName}
              </h3>
              {isActive && (
                <span className="inline-flex min-h-6 shrink-0 items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-2 text-[11px] font-semibold text-primary">
                  <CheckCircle2 size={12} aria-hidden="true" />
                  {t('pages.membership.currentPlan')}
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-baseline gap-2">
              <span className="text-[28px] font-extrabold leading-none tabular-nums text-ink">
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
        </div>

        <MembershipCompareTable
          rows={resolvePlanBenefitLabels(t)}
          planName={planDisplayName}
          t={t}
        />
      </div>

      <div className="grid grid-cols-3 gap-2 p-5">
        <SubscriptionMetric
          label={isActive ? t('pages.membership.expiresAt') : t('pages.membership.membershipPrice')}
          value={isActive ? dateValue : t('pages.membership.notSubscribed')}
        />
        <SubscriptionMetric
          label={t('pages.membership.monthlyMessages')}
          value={formatNumber(monthlyMessages)}
        />
        <SubscriptionMetric
          label={t('pages.membership.monthlyToken')}
          value={formatCompactNumber(monthlyTokens)}
        />
      </div>

      <div className="border-t border-hairline/60 p-4">
        <button
          type="button"
          onClick={() => onSubscribe(plan)}
          disabled={buttonDisabled}
          aria-label={buttonLabel}
          className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[14px] font-semibold text-on-primary transition-colors hover:bg-primary-active disabled:opacity-40"
        >
          {busy ? (
            <Loader2 size={15} className="shrink-0 animate-spin" />
          ) : (
            <Sparkles size={15} className="shrink-0" />
          )}
          {buttonLabel}
        </button>
      </div>
    </section>
  );
}

/**
 * 渲染合并后的「订阅与计费」工作区。
 *
 * 自上而下：订阅卡（去游戏化）· 剩余额度 · 充值区 · 交易流水（可折叠）。
 * 会员数据来自 use-membership-overview，钱包余额/充值/流水来自 use-wallet-overview。
 *
 * @returns 订阅订阅与计费单页视图。
 */
export function MembershipWorkspace() {
  const { confirm } = useConfirm();
  const { toast } = useToast();
  const { formatDate, formatNumber, locale, t } = useI18n();
  const {
    billingInfo,
    usage,
    loading: membershipLoading,
    error: membershipError,
    refresh: refreshMembership,
  } = useMembershipOverview();
  const {
    billingInfo: walletBilling,
    transactions,
    rechargeOrders,
    rechargeStats,
    loading: walletLoading,
    refreshing: walletRefreshing,
    error: walletError,
    refresh: refreshWallet,
  } = useWalletOverview();
  const [membershipBusyPlanKey, setMembershipBusyPlanKey] = useState<
    string | null
  >(null);

  const handleSubscribeMembership = async (plan: MembershipPlan) => {
    const membership = billingInfo?.membership;
    if (!membership || membershipBusyPlanKey || !plan.enabled) return;

    const priceText = formatCoins(plan.monthly_price_coins, locale);
    // 弹窗里用套餐展示名（卦师使用权），与按钮一致，不再泄漏旧档英文名 Clarity。
    const planDisplayName = resolvePlanDisplayName(plan);
    // 单层"卦师使用权"下只有一个在售套餐：存量会员的 plan_key 可能仍是旧档（insight/deep），
    // 不能按 plan_key 相等判断续费，只要会员仍有效即视为续费。
    const isRenewal = Boolean(membership.active);
    const ok = await confirm({
      title: isRenewal
        ? t('pages.membership.confirmRenewTitle')
        : t('pages.membership.confirmSubscribeTitle'),
      message: isRenewal
        ? t('pages.membership.confirmRenewPlanMessage', {
            plan: planDisplayName,
            price: priceText,
          })
        : t('pages.membership.confirmSubscribePlanMessage', {
            plan: planDisplayName,
            price: priceText,
          }),
      confirmLabel: isRenewal
        ? t('pages.membership.confirmRenew')
        : t('pages.membership.confirmSubscribe'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;

    setMembershipBusyPlanKey(plan.plan_key);
    try {
      await billingApi.subscribeMembership({ plan_key: plan.plan_key });
      // 订阅成功后会改变会员状态与额度，两个数据源都要刷新。
      await Promise.all([refreshMembership(), refreshWallet()]);
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

  if (membershipLoading || walletLoading) {
    return (
      <AppShell>
        <div className="space-y-4 pt-5 sm:pt-6 lg:pt-0">
          <div className="h-[220px] rounded-2xl border border-hairline bg-surface-card animate-pulse" />
          <div className="h-[140px] rounded-2xl border border-hairline bg-surface-card animate-pulse" />
          <div className="h-[200px] rounded-2xl border border-hairline bg-surface-card animate-pulse" />
        </div>
      </AppShell>
    );
  }

  const monthlyTokens = billingInfo?.monthly_tokens_used ?? 0;
  const monthlyMessages = usage?.monthly_messages ?? 0;
  const membership = billingInfo?.membership;
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
  // 渲染订阅卡时优先取生效中的套餐；否则回退到在售的 clarity（卦师使用权）。
  const defaultPlan =
    activePlan ??
    membershipPlans.find(
      (plan) =>
        normalizeMembershipPlanKey(plan.plan_key) ===
        MEMBERSHIP_CLARITY_PLAN_KEY,
    ) ??
    membershipPlans[0] ??
    null;

  // 钱包余额拆解：剩余额度 = 充值额度 + 赠送额度（内部仍以 coins 计量）。
  const availableCoins = walletBilling?.available_coins ?? 0;
  const purchasedCoins = walletBilling?.purchased_coins ?? 0;
  const bonusCoins = walletBilling?.bonus_coins ?? 0;

  const combinedError = membershipError || walletError;

  return (
    <AppShell>
      <div className="space-y-5 pt-5 sm:pt-6 lg:pt-0">
        <div className="hidden items-center justify-between gap-3 lg:flex">
          <h2 className="font-display text-base font-semibold tracking-tight">
            {t('pages.membership.title')}
          </h2>
        </div>

        {/* 1. 订阅卡（去游戏化） */}
        {defaultPlan && (
          <SubscriptionCard
            plan={defaultPlan}
            membership={membership}
            monthlyMessages={monthlyMessages}
            monthlyTokens={monthlyTokens}
            busy={membershipBusyPlanKey === defaultPlan.plan_key}
            formatDate={formatDate}
            formatNumber={formatNumber}
            locale={locale}
            onSubscribe={(plan) => void handleSubscribeMembership(plan)}
            t={t}
          />
        )}

        {/* 2. 剩余额度 */}
        <WalletBalanceCard
          availableCoins={availableCoins}
          purchasedCoins={purchasedCoins}
          bonusCoins={bonusCoins}
        />

        {/* 3. 充值区 */}
        <WalletRechargePanel
          orders={rechargeOrders}
          stats={rechargeStats}
          refreshing={walletRefreshing}
          onChanged={refreshWallet}
        />

        {/* 4. 交易流水（默认折叠） */}
        <WalletTransactionsPanel transactions={transactions} />

        {combinedError && (
          <div className="rounded-xl border border-error/30 bg-error/8 px-4 py-3 text-[12px] text-error">
            {combinedError}
          </div>
        )}
      </div>
    </AppShell>
  );
}
