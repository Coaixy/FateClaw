import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDbPool } = vi.hoisted(() => ({
  mockGetDbPool: vi.fn(),
}));

vi.mock('../../../src/infrastructure/db-pool.js', () => ({
  getDbPool: mockGetDbPool,
}));

import {
  ReferralRedeemError,
  redeemReferralInviteCodeUsing,
  settleReferralMembershipRewardUsing,
} from '../../../src/infrastructure/repositories/referrals-repository.js';

interface QueryCall {
  sql: string;
  params?: unknown[];
}

type MockQueryResult = unknown[] | { rows?: unknown[]; rowCount?: number };

function normalizeResult(result: MockQueryResult | undefined) {
  if (Array.isArray(result)) return { rows: result, rowCount: result.length };
  return {
    rows: result?.rows ?? [],
    rowCount: result?.rowCount ?? result?.rows?.length ?? 0,
  };
}

function createMockClient(results: MockQueryResult[]) {
  const calls: QueryCall[] = [];
  let idx = 0;
  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return normalizeResult(results[idx++]);
    },
  };
  return { client: client as never, calls };
}

describe('referrals repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects referral cycles when redeeming an invite code', async () => {
    const { client } = createMockClient([
      [{ enabled: true, inviter_reward_days: 7, monthly_reward_cap_days: 30 }],
      [
        {
          id: 'code-1',
          inviter_id: 'user-b',
          code: 'B-CODE',
          max_redemptions: 10,
          redeemed_count: 0,
          expires_at: null,
          revoked_at: null,
        },
      ],
      [],
      [],
      [],
      [{ found: true }],
    ]);

    await expect(
      redeemReferralInviteCodeUsing(client, {
        inviteeId: 'user-a',
        code: 'B-CODE',
        source: 'redeem',
      }),
    ).rejects.toMatchObject(
      new ReferralRedeemError('cycle', '不能绑定下级用户的邀请码'),
    );
  });

  it('grants configured membership days for eligible paid membership', async () => {
    const { calls, client } = createMockClient([
      [
        {
          id: 'ref-1',
          invite_code_id: 'code-1',
          inviter_id: 'inviter-1',
          invitee_id: 'invitee-1',
          reward_status: 'pending',
          reward_days: 0,
        },
      ],
      [
        {
          enabled: true,
          inviter_reward_days: 7,
          monthly_reward_cap_days: 30,
          reward_first_membership_only: true,
        },
      ],
      [{ total_days: 0 }],
      [],
      [
        {
          user_id: 'inviter-1',
          plan_key: 'fateclaw_plus',
          status: 'active',
          current_period_start: '2026-01-01T00:00:00.000Z',
          current_period_end: '2026-01-08T00:00:00.000Z',
        },
      ],
      [
        {
          id: 'event-1',
          referral_id: 'ref-1',
          inviter_id: 'inviter-1',
          invitee_id: 'invitee-1',
          reward_days: 7,
          status: 'granted',
          reason: 'first_paid_membership',
        },
      ],
      [],
    ]);

    await expect(
      settleReferralMembershipRewardUsing(client, {
        inviteeId: 'invitee-1',
        bonusDeducted: 0,
        purchasedDeducted: 30,
        priceCoins: 30,
        triggerWalletTransactionId: 'wtx-1',
      }),
    ).resolves.toMatchObject({
      id: 'event-1',
      reward_days: 7,
      status: 'granted',
    });

    expect(
      calls.some((call) => call.sql.includes('INSERT INTO user_memberships')),
    ).toBe(true);
    expect(
      calls.some((call) => call.sql.includes('UPDATE user_referrals')),
    ).toBe(true);
  });
});
