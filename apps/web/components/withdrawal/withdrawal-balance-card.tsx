import type { WithdrawalBalance } from '@/features/skills/api';

export function WithdrawalBalanceCard({
  balance,
}: {
  balance: WithdrawalBalance | null;
}) {
  return (
    <section className="rounded-2xl border border-hairline bg-surface-card p-5">
      <div className="text-[11px] font-medium text-muted uppercase tracking-wider mb-1">
        可提现积分
      </div>
      <div className="text-2xl font-extrabold tracking-tight">
        {(balance?.withdrawable_points ?? 0).toLocaleString()} 积分
      </div>
      <div className="text-[12px] text-muted mt-0.5">
        ≈ ¥{balance?.withdrawable_yuan ?? '0.00'}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        <div className="break-words">
          <span className="text-muted">累计收益：</span>
          <span className="font-bold tabular-nums">
            {(balance?.earned_points ?? 0).toLocaleString()}
          </span>
        </div>
        <div className="break-words">
          <span className="text-muted">审核中冻结：</span>
          <span className="font-bold tabular-nums">
            {(balance?.pending_withdrawal_points ?? 0).toLocaleString()}
          </span>
        </div>
      </div>
    </section>
  );
}
