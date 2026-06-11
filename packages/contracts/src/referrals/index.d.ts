/**
 * 邀请返利域跨端契约。
 */

/** 邀请奖励状态。 */
export type ReferralRewardStatusDto =
  | 'pending'
  | 'granted'
  | 'skipped'
  | 'ineligible';

/** 邀请关系绑定来源。 */
export type ReferralBindSourceDto = 'register' | 'redeem';

/** 后台可配置的邀请返会员规则。 */
export interface ReferralConfigDto {
  enabled: boolean;
  inviter_reward_days: number;
  monthly_reward_cap_days: number;
  reward_first_membership_only: boolean;
  updated_at: string;
}

/** 当前用户的邀请概览。 */
export interface MyReferralSummaryDto {
  invite_code: string;
  invite_url: string;
  invited_count: number;
  rewarded_count: number;
  total_reward_days: number;
  config: ReferralConfigDto;
}

/** 公开邀请码预览结果。 */
export interface ReferralInvitePreviewDto {
  code: string;
  status: 'active' | 'disabled' | 'expired' | 'revoked' | 'used_up' | 'invalid';
}

/** 登录用户绑定邀请码的结果。 */
export interface ReferralRedeemResultDto {
  referral_id: string;
  inviter_id: string;
  invitee_id: string;
  created: boolean;
}

/** 管理后台邀请关系列表行。 */
export interface AdminReferralRowDto {
  id: string;
  invite_code: string;
  inviter_id: string;
  inviter_phone: string | null;
  invitee_id: string;
  invitee_phone: string | null;
  bind_source: ReferralBindSourceDto;
  reward_status: ReferralRewardStatusDto;
  reward_days: number;
  reward_event_id: string | null;
  rewarded_at: string | null;
  skip_reason: string | null;
  created_at: string;
}

/** 管理后台邀请关系列表响应。 */
export interface AdminReferralListResponseDto {
  referrals: AdminReferralRowDto[];
  total: number;
}
