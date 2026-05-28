import type { WalletTransaction } from '@/features/billing/api';

import { walletTransactionBadgeLabel } from './wallet-transaction-labels';

export function isWalletTransactionVisible(
  transaction: WalletTransaction,
): boolean {
  return (
    transaction.kind !== 'overage_charge' && transaction.amount_points !== 0
  );
}

export function WalletTransactionsPanel({
  transactions,
}: {
  transactions: WalletTransaction[];
}) {
  const visibleTransactions = transactions.filter(isWalletTransactionVisible);

  return (
    <section className="rounded-2xl border border-hairline bg-surface-card overflow-hidden">
      {visibleTransactions.length === 0 ? (
        <div className="py-12 text-center text-[13px] text-muted">
          暂无交易记录
        </div>
      ) : (
        <div className="divide-y divide-hairline/50">
          {visibleTransactions.map((transaction) => {
            const badgeLabel = walletTransactionBadgeLabel(transaction);
            const points = transaction.amount_points;
            const amountText =
              points !== 0
                ? `${points > 0 ? '+' : ''}${points.toLocaleString()} 积分`
                : transaction.reserved_delta_points > 0
                  ? `预留 ${transaction.reserved_delta_points.toLocaleString()} 积分`
                  : transaction.reserved_delta_points < 0
                    ? `释放 ${Math.abs(transaction.reserved_delta_points).toLocaleString()} 积分`
                    : '';

            return (
              <div
                key={transaction.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13px] font-medium truncate">
                      {transaction.note ||
                        (transaction.kind === 'recharge_topup'
                          ? '充值到账'
                          : transaction.kind)}
                    </span>
                    {badgeLabel && (
                      <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded bg-surface-cream-strong text-muted uppercase tracking-wide">
                        {badgeLabel}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-muted font-mono mt-0.5">
                    {new Date(transaction.created_at).toLocaleString('zh-CN')}
                  </div>
                </div>
                <div
                  className={`shrink-0 text-[13px] font-bold tabular-nums ${
                    points > 0 ? 'text-success' : ''
                  }`}
                >
                  {amountText}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
