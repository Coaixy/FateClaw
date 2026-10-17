'use client';

import { useState } from 'react';
import {
  CheckCircle2,
  Crown,
  Info,
  Loader2,
  ReceiptText,
  Sparkles,
  Wallet,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { WorkspaceTabs } from '@/components/ui/workspace-tabs';
import { WalletBalanceCard } from '@/components/settings/wallet/wallet-balance-card';
import { WalletRechargePanel } from '@/components/settings/wallet/wallet-recharge-panel';
import { WalletTransactionsPanel } from '@/components/settings/wallet/wallet-transactions-panel';
import { billingApi } from '@/features/billing/api';
import { useMembershipOverview } from '@/features/billing/hooks/use-membership-overview';
import { useWalletOverview } from '@/features/billing/hooks/use-wallet-overview';
import { DEFAULT_MEMBERSHIP_NAME } from '@fateclaw/contracts/membership';
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

function resolvePlanDisplayName(plan: Pick<MembershipPlan, 'name'>) {
  return plan.name?.trim() || DEFAULT_MEMBERSHIP_NAME;
}

function resolvePlanBenefitLabels(t: TranslationFn) {
  return [
    t('pages.membership.compareRowModelPrice'),
    t('pages.membership.compareRowBenefitModel'),
    t('pages.membership.compareRowQueue'),
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
    t('pages.membership.compareNonMemberUnavailable'),
    t('pages.membership.compareNonMemberQueue'),
    t('pages.membership.compareNonMemberUnavailable'),
  ];
  const memberValues = [
    t('pages.membership.compareMemberModelPrice'),
    t('pages.membership.compareMemberBenefitModel'),
    t('pages.membership.compareMemberQueue'),
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
      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-5 text-muted/80">
        <Info
          size={12}
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-muted/50"
        />
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
          label={
            isActive
              ? t('pages.membership.expiresAt')
              : t('pages.membership.membershipPrice')
          }
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

/** Keep subscription and wallet refreshes shared across all billing tabs. */
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
  const [membershipBusy, setMembershipBusy] = useState(false);

  const handleSubscribeMembership = async (plan: MembershipPlan) => {
    const membership = billingInfo?.membership;
    if (!membership || membershipBusy || !plan.enabled) return;

    const priceText = formatCoins(plan.monthly_price_coins, locale);
    const planDisplayName = resolvePlanDisplayName(plan);
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

    setMembershipBusy(true);
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
      setMembershipBusy(false);
    }
  };

  if (membershipLoading || walletLoading) {
    return (
      <AppShell>
        <div className="space-y-4 pt-5 sm:pt-6 lg:pt-0">
          <div className="h-[220px] rounded-2xl border border-hairline bg-surface-card animate-pulse" />
        </div>
      </AppShell>
    );
  }

  const monthlyTokens = billingInfo?.monthly_tokens_used ?? 0;
  const monthlyMessages = usage?.monthly_messages ?? 0;
  const membership = billingInfo?.membership;
  const membershipPlans = billingInfo?.membership_plans ?? [];
  const defaultPlan = membershipPlans[0] ?? null;

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

        <WorkspaceTabs
          label={t('pages.membership.title')}
          tabs={[
            {
              id: 'subscription',
              label: t('pages.membership.tabs.subscription'),
              icon: Crown,
              content: defaultPlan ? (
                <SubscriptionCard
                  plan={defaultPlan}
                  membership={membership}
                  monthlyMessages={monthlyMessages}
                  monthlyTokens={monthlyTokens}
                  busy={membershipBusy}
                  formatDate={formatDate}
                  formatNumber={formatNumber}
                  locale={locale}
                  onSubscribe={(plan) => void handleSubscribeMembership(plan)}
                  t={t}
                />
              ) : (
                <div className="rounded-2xl border border-hairline bg-surface-raised px-4 py-12 text-center text-[13px] text-muted">
                  {t('pages.membership.noPlans')}
                </div>
              ),
            },
            {
              id: 'recharge',
              label: t('pages.membership.tabs.recharge'),
              icon: Wallet,
              content: (
                <>
                  <WalletBalanceCard
                    availableCoins={availableCoins}
                    purchasedCoins={purchasedCoins}
                    bonusCoins={bonusCoins}
                  />
                  <WalletRechargePanel
                    orders={rechargeOrders}
                    stats={rechargeStats}
                    refreshing={walletRefreshing}
                    onChanged={refreshWallet}
                  />
                </>
              ),
            },
            {
              id: 'transactions',
              label: t('pages.membership.tabs.transactions'),
              icon: ReceiptText,
              content: <WalletTransactionsPanel transactions={transactions} />,
            },
          ]}
        />

        {combinedError && (
          <div className="rounded-xl border border-error/30 bg-error/8 px-4 py-3 text-[12px] text-error">
            {combinedError}
          </div>
        )}
      </div>
    </AppShell>
  );
}
