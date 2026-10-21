/**
 * 认证域跨端契约。
 */

export type UserRole = 'consumer' | 'creator' | 'both' | 'admin';

export interface UserDto {
  id: string;
  /** 普通用户态只返回脱敏手机号；OAuth-only 用户可能尚未绑定手机号。 */
  phone: string | null;
  /** 与 phone 相同的显式脱敏展示字段，便于前端迁移到语义化命名。 */
  phone_masked: string | null;
  phone_verified: boolean;
  /** 是否已经设置本地密码；第三方登录账号可能没有本地密码。 */
  has_password: boolean;
  role: UserRole;
  purchased_coins: number;
  bonus_coins: number;
  reserved_coins: number;
  created_at: string;
}

export interface AuthResponseDto {
  token: string;
  user: UserDto;
}

export interface RegisterRequestDto {
  phoneNumber: string;
  password: string;
  smsCaptchaCode: string;
  /** Optional; a valid invitation grants 72 hours of membership at registration. */
  inviteCode?: string;
}

export interface RegistrationInviteTierDto {
  threshold_yuan: number;
  total_slots: number;
}

export interface RegistrationInvitePolicyDto {
  tiers: RegistrationInviteTierDto[];
  expires_in_days: number;
  revision: number;
}

export interface RegistrationInvitePolicyUpdateDto {
  tiers: RegistrationInviteTierDto[];
  expires_in_days: number;
  expected_revision: number;
}

export type RegistrationInviteStatus =
  | 'active'
  | 'used'
  | 'revoked'
  | 'expired'
  | 'suspended';

export interface RegistrationInviteDto {
  id: string;
  code_suffix: string;
  source: 'user' | 'admin';
  status: RegistrationInviteStatus;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export interface CreatedRegistrationInviteDto {
  invite: RegistrationInviteDto;
  /** Null on an idempotent replay; the full code is never persisted. */
  code: string | null;
}

export interface CreateRegistrationInviteRequestDto {
  request_key: string;
}

export interface RegistrationInviteSummaryDto {
  user_id: string;
  policy: RegistrationInvitePolicyDto;
  net_recharge_yuan: number;
  eligible: boolean;
  eligibility_reason: 'eligible' | 'below_threshold' | 'suspended';
  total_slots: number;
  automatic_slots: number;
  manual_slot_adjustment: number;
  used_slots: number;
  reserved_slots: number;
  available_slots: number;
  suspended: boolean;
  revision: number;
  invitations: RegistrationInviteDto[];
}

export interface RegistrationInviteAccountUpdateDto {
  total_slots: number;
  suspended: boolean;
  expected_revision: number;
}

export interface RegistrationInvitePreviewDto {
  valid: true;
  expires_at: string;
}

export interface CompletedRechargeRefundDto {
  id: string;
  trade_id: string;
  amount_yuan: number;
  reference: string;
  reason: string;
  created_at: string;
}

export interface CompletedRechargeRefundRequestDto {
  trade_id: string;
  amount_yuan: number;
  reference: string;
  reason: string;
}

export interface CaptchaChallengeDto {
  token: string;
  svg: string;
}

export interface SendSMSCaptchaResponseDto {
  success: true;
}

export interface ChangePasswordRequestDto {
  current_password: string;
  new_password: string;
}

export interface ResetPasswordRequestDto {
  phoneNumber: string;
  newPassword: string;
  smsCaptchaCode: string;
}
