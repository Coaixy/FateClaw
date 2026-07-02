'use client';

import { useState } from 'react';

import type { WalletTransaction } from '@/features/billing/api';
import { useI18n } from '@/lib/i18n';
import { formatSignedCoins, formatCoins } from '@/lib/soft-currency';

import {
  isWalletTransactionVisible,
  walletTransactionBadgeLabel,
} from './wallet-transaction-labels';

const TRANSACTION_PREVIEW_LIMIT = 5;

/**
 * 渲染钱包流水列表。
 *
 * @param props.transactions 钱包流水原始列表。
 * @returns 默认折叠的钱包流水卡片，避免充值页一次性展示过多历史记录。
 */
export function WalletTransactionsPanel({
  transactions,
}: {
  transactions: WalletTransaction[];
}) {
  const { formatDate, formatNumber, locale, t } = useI18n();
  const [transactionsOpen, setTransactionsOpen] = useState(false);
  const visibleTransactions = transactions.filter(isWalletTransactionVisible);
  const canToggleTransactions =
    visibleTransactions.length > TRANSACTION_PREVIEW_LIMIT;
  const shownTransactions = transactionsOpen
    ? visibleTransactions
    : visibleTransactions.slice(0, TRANSACTION_PREVIEW_LIMIT);

  return (
    <section className="rounded-2xl border border-hairline bg-surface-raised overflow-hidden">
      {visibleTransactions.length === 0 ? (
        <div className="py-12 text-center text-[13px] text-muted">
          {t('pages.wallet.noTransactions')}
        </div>
      ) : (
        <>
          <div className="divide-y divide-hairline/50">
            {shownTransactions.map((transaction) => {
              const badgeLabel = walletTransactionBadgeLabel(transaction, t);
              const amountCoins = transaction.amount_coins;
              const amountText =
                amountCoins !== 0
                  ? formatSignedCoins(amountCoins, locale)
                  : transaction.reserved_delta_coins > 0
                    ? t('pages.wallet.reserved', {
                        coins: formatCoins(
                          transaction.reserved_delta_coins,
                          locale,
                        ),
                      })
                    : transaction.reserved_delta_coins < 0
                      ? t('pages.wallet.released', {
                          coins: formatCoins(
                            Math.abs(transaction.reserved_delta_coins),
                            locale,
                          ),
                        })
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
                            ? t('pages.wallet.rechargeReceived')
                            : transaction.kind)}
                      </span>
                      {badgeLabel && (
                        <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded bg-surface-cream-strong text-muted uppercase tracking-wide">
                          {badgeLabel}
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-muted font-mono mt-0.5">
                      {formatDate(transaction.created_at, {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                  </div>
                  <div
                    className={`shrink-0 text-[13px] font-bold tabular-nums ${
                      amountCoins > 0 ? 'text-success' : ''
                    }`}
                  >
                    {amountText}
                  </div>
                </div>
              );
            })}
          </div>

          {canToggleTransactions && (
            <div className="border-t border-hairline/50 px-4 py-3 text-center">
              <button
                type="button"
                onClick={() => setTransactionsOpen((value) => !value)}
                className="inline-flex h-8 items-center justify-center rounded-lg px-3 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10"
                aria-expanded={transactionsOpen}
              >
                {transactionsOpen
                  ? t('pages.wallet.collapseTransactions')
                  : t('pages.wallet.expandTransactions', {
                      count: formatNumber(visibleTransactions.length),
                    })}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
