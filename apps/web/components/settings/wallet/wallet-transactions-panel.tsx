import type { WalletTransaction } from '@/features/billing/api';
import { formatSignedCents, formatCents } from '@/lib/money';

import {
  isWalletTransactionVisible,
  walletTransactionBadgeLabel,
} from './wallet-transaction-labels';

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
            const amountCents = transaction.amount_cents;
            const amountText =
              amountCents !== 0
                ? formatSignedCents(amountCents)
                : transaction.reserved_delta_cents > 0
                  ? `预留 ${formatCents(transaction.reserved_delta_cents)}`
                  : transaction.reserved_delta_cents < 0
                    ? `释放 ${formatCents(Math.abs(transaction.reserved_delta_cents))}`
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
                    amountCents > 0 ? 'text-success' : ''
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
