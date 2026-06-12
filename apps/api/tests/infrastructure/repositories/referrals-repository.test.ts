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

  it('grants membership days when invite count reaches the configured milestone', async () => {
    const { calls, client } = createMockClient([
      [
        {
          enabled: true,
          inviter_reward_days: 7,
          monthly_reward_cap_days: 30,
          reward_first_membership_only: true,
          invite_count_reward_threshold: 10,
          invite_count_reward_days: 7,
          invite_count_reward_max_invites: 50,
        },
      ],
      [
        {
          id: 'code-1',
          inviter_id: 'inviter-1',
          code: 'A-CODE',
          max_redemptions: 100,
          redeemed_count: 9,
          expires_at: null,
          revoked_at: null,
        },
      ],
      [],
      [],
      [],
      [{ found: false }],
      [
        {
          id: 'ref-10',
          invite_code_id: 'code-1',
          inviter_id: 'inviter-1',
          invitee_id: 'invitee-10',
          bind_source: 'redeem',
          reward_status: 'pending',
          reward_days: 0,
        },
      ],
      [],
      [{ invite_count: 10 }],
      [
        {
          id: 'event-10',
          referral_id: 'ref-10',
          inviter_id: 'inviter-1',
          invitee_id: 'invitee-10',
          reward_days: 7,
          status: 'granted',
          reason: 'invite_count_milestone',
        },
      ],
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
    ]);

    await expect(
      redeemReferralInviteCodeUsing(client, {
        inviteeId: 'invitee-10',
        code: 'A-CODE',
        source: 'redeem',
      }),
    ).resolves.toMatchObject({
      created: true,
      referral: { id: 'ref-10' },
    });

    expect(
      calls.some(
        (call) =>
          call.sql.includes('INSERT INTO referral_reward_events') &&
          call.params?.includes('invite_count_milestone'),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.sql.includes('INSERT INTO user_memberships') &&
          call.params?.[0] === 'inviter-1',
      ),
    ).toBe(true);
  });

  it('does not grant invite count rewards beyond the configured max invites', async () => {
    const { calls, client } = createMockClient([
      [
        {
          enabled: true,
          inviter_reward_days: 7,
          monthly_reward_cap_days: 30,
          reward_first_membership_only: true,
          invite_count_reward_threshold: 10,
          invite_count_reward_days: 7,
          invite_count_reward_max_invites: 50,
        },
      ],
      [
        {
          id: 'code-1',
          inviter_id: 'inviter-1',
          code: 'A-CODE',
          max_redemptions: 100,
          redeemed_count: 59,
          expires_at: null,
          revoked_at: null,
        },
      ],
      [],
      [],
      [],
      [{ found: false }],
      [
        {
          id: 'ref-60',
          invite_code_id: 'code-1',
          inviter_id: 'inviter-1',
          invitee_id: 'invitee-60',
          bind_source: 'redeem',
          reward_status: 'pending',
          reward_days: 0,
        },
      ],
      [],
      [{ invite_count: 60 }],
    ]);

    await expect(
      redeemReferralInviteCodeUsing(client, {
        inviteeId: 'invitee-60',
        code: 'A-CODE',
        source: 'redeem',
      }),
    ).resolves.toMatchObject({
      created: true,
      referral: { id: 'ref-60' },
    });

    expect(
      calls.some((call) =>
        call.sql.includes('INSERT INTO referral_reward_events'),
      ),
    ).toBe(false);
    expect(
      calls.some((call) => call.sql.includes('INSERT INTO user_memberships')),
    ).toBe(false);
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
          invite_count_reward_threshold: 10,
          invite_count_reward_days: 7,
          invite_count_reward_max_invites: 50,
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
