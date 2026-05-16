import { describe, expect, it } from 'vitest';

import { walletTransactionBadgeLabel } from './wallet-transaction-labels';

describe('walletTransactionBadgeLabel', () => {
  it('labels official model token charges as deductions, not recharge', () => {
    expect(
      walletTransactionBadgeLabel({
        kind: 'overage_charge',
        amount_points: -12,
        point_source: 'purchased',
      }),
    ).toBe('扣费');
  });

  it('keeps purchased top-ups labeled as recharge', () => {
    expect(
      walletTransactionBadgeLabel({
        kind: 'recharge_topup',
        amount_points: 100,
        point_source: 'purchased',
      }),
    ).toBe('充值');
  });
});
