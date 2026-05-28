import { describe, expect, it } from 'vitest';

import { walletTransactionBadgeLabel } from './wallet-transaction-labels';
import { mergeOfficialModelCharges } from './wallet-transactions-panel';

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

describe('mergeOfficialModelCharges', () => {
  it('groups legacy split official model charges by request', () => {
    const merged = mergeOfficialModelCharges([
      {
        id: 'wtx-1',
        user_id: 'user-1',
        kind: 'overage_charge',
        amount_points: -3,
        reserved_delta_points: 0,
        point_source: 'bonus',
        point_batch_id: 'batch-1',
        request_id: 'request-1',
        note: '官方模型 Token 扣费（赠送积分批次）',
        metadata: null,
        created_at: '2026-05-28T00:00:01.000Z',
      },
      {
        id: 'wtx-2',
        user_id: 'user-1',
        kind: 'overage_charge',
        amount_points: -7,
        reserved_delta_points: 0,
        point_source: 'purchased',
        point_batch_id: null,
        request_id: 'request-1',
        note: '官方模型 Token 扣费',
        metadata: null,
        created_at: '2026-05-28T00:00:00.000Z',
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      amount_points: -10,
      point_source: 'mixed',
      point_batch_id: null,
      note: '官方模型 Token 扣费',
    });
  });
});
