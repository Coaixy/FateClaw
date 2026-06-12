'use client';

import { useState } from 'react';
import { CalendarCheck, Loader2 } from 'lucide-react';

import {
  billingApi,
  type DailySignInStatus,
} from '@/features/billing/api';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';
import { formatCoins } from '@/lib/soft-currency';

export function WalletDailySignInPanel({
  status,
  refreshing,
  onChanged,
}: {
  status: DailySignInStatus | null;
  refreshing: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const { toast } = useToast();
  const { locale, t } = useI18n();
  const [busy, setBusy] = useState(false);

  const enabled = Boolean(status?.enabled);
  const signedIn = Boolean(status?.signed_in_today);
  const rewardCoins = status?.reward_coins ?? 0;
  const canClaim = enabled && !signedIn && rewardCoins > 0;

  const claim = async () => {
    setBusy(true);
    try {
      const result = await billingApi.claimDailySignIn();
      toast(
        'success',
        t('pages.dailySignIn.claimed', {
          coins: formatCoins(result.received_coins, locale),
        }),
      );
      await onChanged();
    } catch (err) {
      toast(
        'error',
        err instanceof Error ? err.message : t('pages.dailySignIn.claimFailed'),
      );
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const statusText = !enabled
    ? t('pages.dailySignIn.disabled')
    : signedIn
      ? t('pages.dailySignIn.signedToday')
      : rewardCoins > 0
        ? t('pages.dailySignIn.claimable', {
            coins: formatCoins(rewardCoins, locale),
          })
        : t('pages.dailySignIn.rewardMissing');

  return (
    <section className="rounded-2xl border border-hairline bg-surface-card px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-cream-strong text-primary">
            <CalendarCheck size={18} />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold">
              {t('pages.dailySignIn.title')}
            </div>
            <div className="mt-1 text-[12px] text-muted">{statusText}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void claim()}
          disabled={!canClaim || busy || refreshing}
          className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-[13px] font-medium text-on-primary disabled:cursor-not-allowed disabled:opacity-45"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : null}
          {signedIn
            ? t('pages.dailySignIn.signedButton')
            : t('pages.dailySignIn.signButton')}
        </button>
      </div>
    </section>
  );
}
