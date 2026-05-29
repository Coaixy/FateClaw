'use client';

import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { WithdrawalBalanceCard } from '@/components/withdrawal/withdrawal-balance-card';
import {
  WithdrawalForm,
} from '@/components/withdrawal/withdrawal-form';
import { WithdrawalHistory } from '@/components/withdrawal/withdrawal-history';
import { useWithdrawal } from '@/features/skills/hooks/use-withdrawal';

export function WithdrawalWorkspace() {
  const withdrawal = useWithdrawal();

  return (
    <AppShell>
      <div className="mb-5 space-y-2">
        <Link
          href="/settings?tab=wallet"
          className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink transition-colors"
        >
          <ArrowLeft size={13} />
          返回钱包
        </Link>
        <h2 className="text-base font-semibold tracking-tight">创作者提现</h2>
        <p className="text-[12px] text-muted leading-relaxed break-words">
          提现金额按软妹币余额结算。申请后平台将于 3–5
          个工作日内完成税务核验和打款。
        </p>
      </div>

      {withdrawal.loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="animate-spin" />
        </div>
      ) : (
        <div className="space-y-6">
          <WithdrawalBalanceCard balance={withdrawal.balance} />
          <WithdrawalForm
            values={withdrawal.form}
            error={withdrawal.error}
            success={withdrawal.success}
            submitting={withdrawal.submitting}
            onSubmit={withdrawal.submit}
            onChange={withdrawal.updateField}
          />
          <WithdrawalHistory records={withdrawal.records} />
        </div>
      )}
    </AppShell>
  );
}
