import type {
  MyReferralSummaryDto,
  ReferralInvitePreviewDto,
  ReferralRedeemResultDto,
} from '@fateclaw/contracts/referrals';

import {
  getBoundReferralForUser,
  getReferralConfig,
  getReferralSummaryForUser,
  previewReferralInviteCode,
  redeemReferralInviteCode,
  referralRedeemErrorMessage,
} from '../../infrastructure/db.js';
import { ReferralRedeemError } from '../../infrastructure/repositories/referrals-repository.js';
import { PUBLIC_WEB_BASE_URL } from '../../infrastructure/config.js';
import { fail, ok, type ServiceResult } from '../../shared/service-result.js';

function inviteUrl(code: string): string {
  const path = `/invite?code=${encodeURIComponent(code)}`;
  return PUBLIC_WEB_BASE_URL ? `${PUBLIC_WEB_BASE_URL}${path}` : path;
}

/**
 * 读取当前用户的邀请概览。
 */
export async function getMyReferralSummary(
  userId: string,
): Promise<ServiceResult<MyReferralSummaryDto>> {
  const [summary, config, boundReferral] = await Promise.all([
    getReferralSummaryForUser(userId),
    getReferralConfig(),
    getBoundReferralForUser(userId),
  ]);
  return ok({
    invite_code: summary.inviteCode.code,
    invite_url: inviteUrl(summary.inviteCode.code),
    invited_count: summary.invitedCount,
    rewarded_count: summary.rewardedCount,
    total_reward_days: summary.totalRewardDays,
    bound_referral: boundReferral
      ? {
          created_at: boundReferral.created_at,
        }
      : null,
    config: {
      enabled: config.enabled,
      inviter_reward_days: config.inviter_reward_days,
      monthly_reward_cap_days: config.monthly_reward_cap_days,
      reward_first_membership_only: config.reward_first_membership_only,
      invite_count_reward_threshold: config.invite_count_reward_threshold,
      invite_count_reward_days: config.invite_count_reward_days,
      invite_count_reward_max_invites: config.invite_count_reward_max_invites,
      updated_at: config.updated_at,
    },
  });
}

/**
 * 公开预览邀请码状态。
 */
export async function previewInviteCode(
  code: string,
): Promise<ServiceResult<ReferralInvitePreviewDto>> {
  const preview = await previewReferralInviteCode(code);
  return ok(preview);
}

/**
 * 登录用户绑定邀请码。
 */
export async function redeemInviteCodeForUser(
  userId: string,
  code: string,
): Promise<ServiceResult<ReferralRedeemResultDto>> {
  try {
    const result = await redeemReferralInviteCode({
      inviteeId: userId,
      code,
      source: 'redeem',
    });
    return ok({
      referral_id: result.referral.id,
      inviter_id: result.referral.inviter_id,
      invitee_id: result.referral.invitee_id,
      created: result.created,
    });
  } catch (error) {
    if (error instanceof ReferralRedeemError) {
      return fail(error.code === 'invalid' ? 404 : 400, error.message);
    }
    return fail(400, referralRedeemErrorMessage('invalid'));
  }
}
