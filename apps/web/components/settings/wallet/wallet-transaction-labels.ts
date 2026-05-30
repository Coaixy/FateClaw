import type { WalletTransaction } from '@/features/billing/api';

type WalletTransactionBadgeInput = Pick<
  WalletTransaction,
  'kind' | 'amount_cents' | 'balance_source'
>;

function positiveBalanceSourceLabel(
  source: WalletTransaction['balance_source'],
): string | null {
  switch (source) {
    case 'purchased':
      return '充值';
    case 'bonus':
      return '赠送';
    case 'mixed':
      return '混合';
    default:
      return null;
  }
}

function negativeTransactionLabel(kind: string): string {
  switch (kind) {
    case 'overage_charge':
      return '扣费';
    case 'skill_subscription':
    case 'bundle_subscription':
      return '订阅';
    case 'manual_adjustment':
      return '扣减';
    default:
      return '支出';
  }
}

export function walletTransactionBadgeLabel(
  transaction: WalletTransactionBadgeInput,
): string | null {
  if (transaction.amount_cents < 0) {
    return negativeTransactionLabel(transaction.kind);
  }

  return positiveBalanceSourceLabel(transaction.balance_source);
}

export function isWalletTransactionVisible(
  transaction: WalletTransaction,
): boolean {
  return (
    transaction.kind !== 'overage_charge' && transaction.amount_cents !== 0
  );
}
