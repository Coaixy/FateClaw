'use client';

import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Gift,
  Loader2,
  Sparkles,
  TicketPercent,
  WalletCards,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import {
  billingApi,
  type BillingStatus,
  type GiftCodeRedeemResult,
} from '@/features/billing/api';
import { useBillingSnapshot } from '@/features/billing/hooks/use-billing-snapshot';
import { useI18n } from '@/lib/i18n';
import { formatCoins } from '@/lib/soft-currency';
import { useToast } from '@/lib/use-toast';

type BalanceSnapshot = Pick<
  BillingStatus,
  'purchased_coins' | 'bonus_coins' | 'available_coins'
>;

function balanceTypeLabel(
  result: GiftCodeRedeemResult | null,
  t: (key: string, params?: Record<string, string | number>) => string,
) {
  if (!result) return '';
  return result.gift_code.balance_type === 'purchased'
    ? t('pages.gifts.typePurchased')
    : t('pages.gifts.typeBonus');
}

function usageTypeLabel(
  result: GiftCodeRedeemResult | null,
  t: (key: string, params?: Record<string, string | number>) => string,
) {
  if (!result) return '';
  return result.gift_code.usage_type === 'single'
    ? t('pages.gifts.usageSingle')
    : t('pages.gifts.usageMulti');
}

function BalanceMetric({
  label,
  value,
  emphasized,
}: {
  label: string;
  value: string;
  emphasized?: boolean;
}) {
  return (
    <div className="rounded-xl border border-hairline/70 bg-canvas/50 px-3 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
        {label}
      </div>
      <div
        className={`mt-1 text-[16px] font-extrabold tabular-nums ${
          emphasized ? 'text-primary' : 'text-ink'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function RedeemSuccess({
  result,
  locale,
  t,
}: {
  result: GiftCodeRedeemResult;
  locale: Parameters<typeof formatCoins>[1];
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const receivedCoins = formatCoins(result.redemption.amount_coins, locale);
  const successText =
    result.gift_code.balance_type === 'purchased'
      ? t('pages.gifts.successPurchased', { coins: receivedCoins })
      : t('pages.gifts.successBonus', { coins: receivedCoins });

  return (
    <div className="animate-scale-in rounded-2xl border border-primary/25 bg-primary/8 p-5">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="relative flex h-20 w-20 items-center justify-center">
          <span className="absolute inset-0 rounded-full border border-primary/35 animate-gift-ring" />
          <span className="absolute inset-2 rounded-full bg-primary/12" />
          <span className="absolute -top-3 rounded-full bg-primary px-2 py-1 text-[12px] font-bold text-on-primary shadow-lg animate-gift-coin-pop">
            {t('pages.gifts.animationCoins', { coins: receivedCoins })}
          </span>
          <CheckCircle2 size={34} className="relative text-primary" />
        </div>
        <div>
          <div className="text-lg font-extrabold">
            {t('pages.gifts.successTitle')}
          </div>
          <div className="mt-1 text-[13px] text-muted">{successText}</div>
        </div>
        <div className="flex flex-wrap justify-center gap-2 text-[11px] text-muted">
          <span className="rounded-full border border-hairline bg-canvas/55 px-2 py-1">
            {balanceTypeLabel(result, t)}
          </span>
          <span className="rounded-full border border-hairline bg-canvas/55 px-2 py-1">
            {usageTypeLabel(result, t)}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * 用户礼品兑换页。
 *
 * @returns 可输入礼品码、查看兑换结果和余额变化的页面。
 */
export default function GiftsPage() {
  const { locale, t } = useI18n();
  const { toast } = useToast();
  const { status, loading } = useBillingSnapshot();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<GiftCodeRedeemResult | null>(null);

  const balance = useMemo<BalanceSnapshot | null>(() => {
    if (result) {
      return {
        purchased_coins: result.purchased_coins,
        bonus_coins: result.bonus_coins,
        available_coins: result.available_coins,
      };
    }
    return status;
  }, [result, status]);

  const redeem = async () => {
    const trimmedCode = code.trim();
    if (!trimmedCode) {
      setError(t('pages.gifts.emptyCode'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const nextResult = await billingApi.redeemGiftCode(trimmedCode);
      setResult(nextResult);
      setCode('');
    } catch (err) {
      setResult(null);
      const message =
        err instanceof Error ? err.message : t('pages.gifts.redeemFailed');
      if (message.includes('礼品码不存在')) {
        setError('');
        toast('error', message);
        return;
      }
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell>
      <div className="space-y-5">
        <div className="relative overflow-hidden rounded-2xl border border-hairline/70 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--color-primary)_10%,transparent),transparent_42%),linear-gradient(180deg,var(--color-surface-card),color-mix(in_srgb,var(--color-canvas)_82%,var(--color-surface-card)))] px-5 py-4 shadow-[0_18px_46px_rgba(20,20,19,0.06)] sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/12 text-primary shadow-sm">
              <TicketPercent size={21} />
            </div>
            <div className="min-w-0">
              <h2 className="font-display text-2xl font-extrabold text-ink sm:text-3xl">
                {t('pages.gifts.title')}
              </h2>
              <div className="mt-1 max-w-xl text-[13px] leading-5 text-muted">
                {t('pages.gifts.subtitle')}
              </div>
            </div>
          </div>
        </div>

        <section className="rounded-2xl border border-hairline bg-surface-card p-5">
          <div className="flex items-center gap-2 text-[12px] font-semibold text-muted">
            <WalletCards size={14} className="text-primary" />
            {t('pages.gifts.balanceTitle')}
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            <BalanceMetric
              label={t('pages.gifts.balanceAvailable')}
              value={
                loading && !balance
                  ? '...'
                  : formatCoins(balance?.available_coins ?? 0, locale)
              }
              emphasized
            />
            <BalanceMetric
              label={t('pages.gifts.balancePurchased')}
              value={formatCoins(balance?.purchased_coins ?? 0, locale)}
            />
            <BalanceMetric
              label={t('pages.gifts.balanceBonus')}
              value={formatCoins(balance?.bonus_coins ?? 0, locale)}
            />
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-hairline bg-surface-card shadow-[0_18px_48px_rgba(15,23,42,0.06)]">
          <div className="border-b border-hairline/60 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--color-primary)_14%,transparent),transparent_54%),linear-gradient(180deg,var(--color-surface-card),var(--color-canvas))] p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/12 text-primary">
                <Gift size={18} />
              </div>
              <div>
                <div className="text-[12px] font-semibold text-muted">
                  {t('pages.gifts.codeLabel')}
                </div>
                <div className="mt-1 text-xl font-extrabold sm:text-2xl">
                  {t('pages.gifts.redeem')}
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-4 p-5 sm:p-6">
            <label className="block space-y-2">
              <span className="text-[12px] font-semibold text-muted">
                {t('pages.gifts.codeLabel')}
              </span>
              <div className="rounded-[22px] border border-hairline bg-canvas/70 p-2 shadow-inner transition-colors focus-within:border-primary/45 focus-within:bg-canvas">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <div className="relative min-w-0 flex-1">
                    <TicketPercent
                      size={18}
                      className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-primary/70"
                    />
                    <input
                      value={code}
                      onChange={(event) => {
                        setCode(event.target.value);
                        setError('');
                      }}
                      placeholder={t('pages.gifts.codePlaceholder')}
                      className="h-14 w-full rounded-2xl border border-transparent bg-surface-card/70 pl-11 pr-4 font-mono text-[16px] uppercase tracking-wide text-ink outline-none transition-colors placeholder:text-muted-soft focus:bg-surface-card"
                      autoComplete="one-time-code"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => void redeem()}
                    disabled={busy}
                    className="inline-flex h-14 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-2xl bg-primary px-6 text-[15px] font-semibold text-on-primary shadow-sm transition-all hover:bg-primary-active disabled:cursor-not-allowed disabled:opacity-60 sm:min-w-40"
                  >
                    {busy ? (
                      <Loader2 size={17} className="animate-spin" />
                    ) : (
                      <Sparkles size={17} />
                    )}
                    {busy
                      ? t('pages.gifts.redeeming')
                      : t('pages.gifts.redeem')}
                  </button>
                </div>
              </div>
            </label>

            {error ? (
              <div className="rounded-xl border border-error/30 bg-error/8 px-4 py-3 text-[12px] text-error">
                {error}
              </div>
            ) : null}

          </div>
        </section>

        {result ? (
          <RedeemSuccess result={result} locale={locale} t={t} />
        ) : null}

      </div>
    </AppShell>
  );
}
