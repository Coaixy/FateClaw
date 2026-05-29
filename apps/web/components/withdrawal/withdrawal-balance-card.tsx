import type { WithdrawalBalance } from '@/features/skills/api';
import { formatCents } from '@/lib/money';

export function WithdrawalBalanceCard({
  balance,
}: {
  balance: WithdrawalBalance | null;
}) {
  return (
    <section className="rounded-2xl border border-hairline bg-surface-card p-5">
      <div className="text-[11px] font-medium text-muted uppercase tracking-wider mb-1">
        可提现余额
      </div>
      <div className="text-2xl font-extrabold tracking-tight">
        {formatCents(balance?.withdrawable_cents ?? 0)}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        <div className="break-words">
          <span className="text-muted">累计收益：</span>
          <span className="font-bold tabular-nums">
            {formatCents(balance?.earned_cents ?? 0)}
          </span>
        </div>
        <div className="break-words">
          <span className="text-muted">审核中冻结：</span>
          <span className="font-bold tabular-nums">
            {formatCents(balance?.pending_withdrawal_cents ?? 0)}
          </span>
        </div>
      </div>
    </section>
  );
}
