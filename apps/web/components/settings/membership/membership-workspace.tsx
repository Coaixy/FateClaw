'use client';

import { useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Coins,
  Crown,
  Info,
  KeyRound,
  Loader2,
  ReceiptText,
  Sparkles,
  Wallet,
  Zap,
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
) {
  if (!value) return '—';
  return (
    formatDate(value, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }) || '—'
  );
}

function resolvePlanDisplayName(plan: Pick<MembershipPlan, 'name'>) {
  return plan.name?.trim() || DEFAULT_MEMBERSHIP_NAME;
}

function MembershipBenefits({
  isActive,
  t,
}: {
  isActive: boolean;
  t: TranslationFn;
}) {
  const benefits = [
    { icon: Coins, title: 'paidModels', description: 'paidModelsDescription' },
    {
      icon: Sparkles,
      title: 'freeModels',
      description: 'freeModelsDescription',
    },
    {
      icon: Zap,
      title: 'priorityAccess',
      description: 'priorityAccessDescription',
    },
    { icon: KeyRound, title: 'openApi', description: 'openApiDescription' },
  ] as const;

  return (
    <div>
      <h4 className="text-[14px] font-semibold text-ink">
        {t(
          isActive
            ? 'pages.membership.yourBenefits'
            : 'pages.membership.includedBenefits',
        )}
      </h4>
      <ul className="mt-5 grid grid-cols-2 gap-x-5 gap-y-6 sm:gap-x-8">
        {benefits.map(({ icon: Icon, title, description }) => (
          <li key={title} className="flex items-start gap-2.5">
            <Icon
              size={18}
              strokeWidth={1.7}
              aria-hidden="true"
              className="mt-0.5 shrink-0 text-primary"
            />
            <div className="min-w-0">
              <p className="text-[14px] font-medium leading-5 text-ink">
                {t(`pages.membership.${title}`)}
              </p>
              <p className="mt-1 text-[12px] leading-5 text-muted">
                {t(`pages.membership.${description}`)}
              </p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-6 flex items-start gap-1.5 text-[11px] leading-5 text-muted">
        <Info size={12} aria-hidden="true" className="mt-1 shrink-0" />
        {t('pages.membership.billingNote')}
      </p>
    </div>
  );
}

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
  const price = formatCoins(plan.monthly_price_coins, locale);
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
  );

  return (
    <section
      aria-label={t('pages.membership.detailAria')}
      className="overflow-hidden rounded-2xl border border-hairline bg-surface-raised shadow-sm"
    >
      {isActive ? (
        <div className="bg-surface-dark px-6 py-6 text-on-dark sm:px-8 sm:py-7">
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 text-[13px] text-on-dark-soft">
              <Crown
                size={18}
                strokeWidth={1.6}
                aria-hidden="true"
                className="text-primary"
              />
              {t('common.brandName')}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/15 px-2.5 py-1 text-[12px] text-primary">
              <CheckCircle2 size={12} aria-hidden="true" />
              {t('pages.membership.subscribed')}
            </span>
          </div>
          <div className="mt-6 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <h3 className="font-display text-[30px] leading-tight sm:text-[32px]">
                {planDisplayName}
              </h3>
              <p className="mt-2 text-[13px] leading-5 text-on-dark-soft">
                {t('pages.membership.activeDescription')}
              </p>
            </div>
            <dl className="border-t border-on-dark/15 pt-4 sm:shrink-0 sm:border-t-0 sm:pt-0 sm:text-right">
              <dt className="text-[11px] text-on-dark-soft">
                {t('pages.membership.expiresAt')}
              </dt>
              <dd className="mt-1 text-[22px] leading-7 tabular-nums text-on-dark">
                {dateValue}
              </dd>
            </dl>
          </div>
        </div>
      ) : (
        <div className="border-b border-hairline/60 bg-canvas px-6 py-6 sm:px-8 sm:py-7">
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 text-[13px] text-muted">
              <Crown
                size={18}
                strokeWidth={1.6}
                aria-hidden="true"
                className="text-primary"
              />
              {t('common.brandName')}
            </span>
            <span className="rounded-full border border-hairline bg-surface-raised px-2.5 py-1 text-[12px] text-muted">
              {t('pages.membership.notSubscribed')}
            </span>
          </div>
          <h3 className="mt-6 font-display text-[30px] leading-tight sm:text-[32px]">
            {planDisplayName}
          </h3>
          <p className="mt-2 text-[13px] leading-5 text-muted">
            {t('pages.membership.inactiveDescription')}
          </p>
          <div className="mt-5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-display text-[32px] leading-tight tabular-nums text-ink">
              {price}
            </span>
            <span className="text-[13px] text-muted">
              {t('pages.membership.perMonth')}
            </span>
            {plan.display_price_coins > plan.monthly_price_coins && (
              <span className="text-[12px] tabular-nums text-muted-soft line-through">
                {formatCoins(plan.display_price_coins, locale)}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="px-6 py-6 sm:px-8">
        <MembershipBenefits isActive={isActive} t={t} />
        {isActive && (
          <div className="mt-6 border-t border-hairline/60 pt-5">
            <h4 className="text-[12px] text-muted">
              {t('pages.membership.monthlyUsage')}
            </h4>
            <dl className="mt-3 grid grid-cols-2 gap-5">
              {[
                {
                  label: t('pages.membership.monthlyMessages'),
                  value: formatNumber(monthlyMessages),
                },
                {
                  label: t('pages.membership.monthlyToken'),
                  value: formatCompactNumber(monthlyTokens),
                },
              ].map(({ label, value }) => (
                <div key={label}>
                  <dt className="text-[11px] text-muted">{label}</dt>
                  <dd className="mt-1 text-[24px] leading-8 tabular-nums text-ink">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>

      <div
        className={`border-t border-hairline/60 px-6 py-5 sm:px-8 ${isActive ? 'flex flex-col gap-4 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-3' : ''}`}
      >
        {isActive && (
          <div className="min-w-0">
            <p className="text-[14px] font-medium text-ink">
              {t('pages.membership.pricePerMonth', { price })}
            </p>
            <p className="mt-1 text-[11px] leading-5 text-muted">
              {t('pages.membership.renewHint')}
            </p>
          </div>
        )}
        <button
          type="button"
          onClick={() => onSubscribe(plan)}
          disabled={buttonDisabled}
          aria-busy={busy}
          className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-[14px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${isActive ? 'border border-hairline bg-canvas text-ink hover:bg-surface-card' : 'w-full bg-primary text-on-primary hover:bg-primary-active'}`}
        >
          {busy && (
            <Loader2
              size={15}
              aria-hidden="true"
              className="shrink-0 animate-spin"
            />
          )}
          {buttonLabel}
          {!busy && (
            <ArrowRight size={15} aria-hidden="true" className="shrink-0" />
          )}
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
