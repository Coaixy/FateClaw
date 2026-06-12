import type { WalletTransaction } from '@/features/billing/api';

type WalletTransactionBadgeInput = Pick<
  WalletTransaction,
  'kind' | 'amount_coins' | 'balance_source'
>;

type TranslationFn = (
  key: string,
  params?: Record<string, string | number>,
) => string;

function translate(
  t: TranslationFn | undefined,
  key: string,
  fallback: string,
): string {
  return t?.(key) ?? fallback;
}

function positiveBalanceSourceLabel(
  source: WalletTransaction['balance_source'],
  t?: TranslationFn,
  kind?: string,
): string | null {
  if (kind === 'bonus_grant') {
    return translate(t, 'pages.wallet.badgeReward', '奖励');
  }
  switch (source) {
    case 'purchased':
      return translate(t, 'pages.wallet.badgePurchased', '充值');
    case 'bonus':
      return translate(t, 'pages.wallet.badgeBonus', '赠送');
    case 'mixed':
      return translate(t, 'pages.wallet.badgeMixed', '混合');
    default:
      return null;
  }
}

function negativeTransactionLabel(kind: string, t?: TranslationFn): string {
  switch (kind) {
    case 'overage_charge':
      return translate(t, 'pages.wallet.badgeCharge', '扣费');
    case 'manual_adjustment':
      return translate(t, 'pages.wallet.badgeDeduct', '扣减');
    default:
      return translate(t, 'pages.wallet.badgeExpense', '支出');
  }
}

export function walletTransactionBadgeLabel(
  transaction: WalletTransactionBadgeInput,
  t?: TranslationFn,
): string | null {
  if (transaction.amount_coins < 0) {
    return negativeTransactionLabel(transaction.kind, t);
  }

  return positiveBalanceSourceLabel(
    transaction.balance_source,
    t,
    transaction.kind,
  );
}

export function isWalletTransactionVisible(
  transaction: WalletTransaction,
): boolean {
  return (
    transaction.kind !== 'overage_charge' && transaction.amount_coins !== 0
  );
}
