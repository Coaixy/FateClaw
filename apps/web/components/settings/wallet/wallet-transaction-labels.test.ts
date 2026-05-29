import { describe, expect, it } from 'vitest';

import {
  isWalletTransactionVisible,
  walletTransactionBadgeLabel,
} from './wallet-transaction-labels';

describe('walletTransactionBadgeLabel', () => {
  it('labels official model token charges as deductions, not recharge', () => {
    expect(
      walletTransactionBadgeLabel({
        kind: 'overage_charge',
        amount_cents: -12,
        balance_source: 'purchased',
      }),
    ).toBe('扣费');
  });

  it('keeps purchased top-ups labeled as recharge', () => {
    expect(
      walletTransactionBadgeLabel({
        kind: 'recharge_topup',
        amount_cents: 100,
        balance_source: 'purchased',
      }),
    ).toBe('充值');
  });
});

describe('isWalletTransactionVisible', () => {
  it('hides official model token charges from wallet flow', () => {
    expect(
      isWalletTransactionVisible({
        id: 'wtx-1',
        user_id: 'user-1',
        kind: 'overage_charge',
        amount_cents: -3,
        reserved_delta_cents: 0,
        balance_source: 'bonus',
        balance_grant_id: 'batch-1',
        request_id: 'request-1',
        note: '官方模型 Token 扣费（赠送余额批次）',
        metadata: null,
        created_at: '2026-05-28T00:00:01.000Z',
      }),
    ).toBe(false);
  });

  it('keeps recharge records in wallet flow', () => {
    expect(
      isWalletTransactionVisible({
        id: 'wtx-2',
        user_id: 'user-1',
        kind: 'recharge_topup',
        amount_cents: 100,
        reserved_delta_cents: 0,
        balance_source: 'purchased',
        balance_grant_id: null,
        request_id: null,
        note: '充值到账',
        metadata: null,
        created_at: '2026-05-28T00:00:00.000Z',
      }),
    ).toBe(true);
  });
});
