import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetBoundReferralForUser,
  mockGetReferralConfig,
  mockGetReferralSummaryForUser,
  mockPreviewReferralInviteCode,
  mockRedeemReferralInviteCode,
} = vi.hoisted(() => ({
  mockGetBoundReferralForUser: vi.fn(),
  mockGetReferralConfig: vi.fn(),
  mockGetReferralSummaryForUser: vi.fn(),
  mockPreviewReferralInviteCode: vi.fn(),
  mockRedeemReferralInviteCode: vi.fn(),
}));

vi.mock('../../../src/infrastructure/config.js', () => ({
  PUBLIC_WEB_BASE_URL: '',
}));

vi.mock('../../../src/infrastructure/db.js', () => ({
  getBoundReferralForUser: mockGetBoundReferralForUser,
  getReferralConfig: mockGetReferralConfig,
  getReferralSummaryForUser: mockGetReferralSummaryForUser,
  previewReferralInviteCode: mockPreviewReferralInviteCode,
  redeemReferralInviteCode: mockRedeemReferralInviteCode,
  referralRedeemErrorMessage: vi.fn(() => '邀请码无效'),
}));

import { getMyReferralSummary } from '../../../src/modules/referrals/referrals-service.js';

describe('referrals service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetReferralSummaryForUser.mockResolvedValue({
      inviteCode: { code: 'ABC123' },
      invitedCount: 1,
      rewardedCount: 0,
      totalRewardDays: 0,
    });
    mockGetReferralConfig.mockResolvedValue({
      enabled: true,
      reward_membership_plan_key: 'fateclaw_insight',
      inviter_reward_days: 7,
      monthly_reward_cap_days: 30,
      reward_first_membership_only: true,
      invite_count_reward_threshold: 10,
      invite_count_reward_days: 7,
      invite_count_reward_max_invites: 50,
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    mockGetBoundReferralForUser.mockResolvedValue(null);
  });

  it('includes bound referral status in current user summary', async () => {
    mockGetBoundReferralForUser.mockResolvedValue({
      id: 'ref-1',
      invite_code_id: 'code-1',
      inviter_id: 'inviter-1',
      invitee_id: 'user-1',
      bind_source: 'redeem',
      reward_status: 'pending',
      reward_days: 0,
      reward_event_id: null,
      rewarded_at: null,
      skip_reason: null,
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
    });

    await expect(getMyReferralSummary('user-1')).resolves.toMatchObject({
      ok: true,
      data: {
        invite_code: 'ABC123',
        bound_referral: {
          created_at: '2026-06-01T00:00:00.000Z',
        },
      },
    });
    expect(mockGetBoundReferralForUser).toHaveBeenCalledWith('user-1');
  });
});
