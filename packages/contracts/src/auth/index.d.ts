/**
 * 认证域跨端契约。
 */

export type UserRole = 'consumer' | 'creator' | 'both' | 'admin';

export interface UserDto {
  id: string;
  phone: string;
  phone_verified: boolean;
  role: UserRole;
  purchased_cents: number;
  bonus_cents: number;
  earned_cents: number;
  reserved_cents: number;
  pending_withdrawal_cents: number;
  created_at: string;
}

export interface AuthResponseDto {
  token: string;
  user: UserDto;
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
