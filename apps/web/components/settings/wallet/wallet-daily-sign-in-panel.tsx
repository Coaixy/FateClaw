'use client';

import { useState } from 'react';
import { CalendarCheck, Loader2 } from 'lucide-react';

import {
  billingApi,
  type DailySignInStatus,
} from '@/features/billing/api';
import { useToast } from '@/lib/use-toast';
import { formatCents } from '@/lib/money';

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
  const [busy, setBusy] = useState(false);

  const enabled = Boolean(status?.enabled);
  const signedIn = Boolean(status?.signed_in_today);
  const rewardCents = status?.reward_cents ?? 0;
  const canClaim = enabled && !signedIn && rewardCents > 0;

  const claim = async () => {
    setBusy(true);
    try {
      const result = await billingApi.claimDailySignIn();
      toast('success', `已领取 ${formatCents(result.received_cents)}`);
      await onChanged();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '签到失败');
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const statusText = !enabled
    ? '暂未开启'
    : signedIn
      ? '今日已签到'
      : rewardCents > 0
        ? `今日可领 ${formatCents(rewardCents)}`
        : '奖励未配置';

  return (
    <section className="rounded-2xl border border-hairline bg-surface-card px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-cream-strong text-primary">
            <CalendarCheck size={18} />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold">每日签到</div>
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
          {signedIn ? '已签到' : '签到'}
        </button>
      </div>
    </section>
  );
}
