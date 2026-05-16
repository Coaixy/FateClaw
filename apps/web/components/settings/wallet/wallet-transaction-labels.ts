import type { WalletTransaction } from '@/features/billing/api';

type WalletTransactionBadgeInput = Pick<
  WalletTransaction,
  'kind' | 'amount_points' | 'point_source'
>;

function positivePointSourceLabel(
  source: WalletTransaction['point_source'],
): string | null {
  switch (source) {
    case 'purchased':
      return '充值';
    case 'bonus':
      return '赠送';
    case 'earned':
      return '收益';
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
    case 'withdrawal':
      return '提现';
    case 'manual_adjustment':
      return '扣减';
    default:
      return '支出';
  }
}

export function walletTransactionBadgeLabel(
  transaction: WalletTransactionBadgeInput,
): string | null {
  if (transaction.amount_points < 0) {
    return negativeTransactionLabel(transaction.kind);
  }

  return positivePointSourceLabel(transaction.point_source);
}
