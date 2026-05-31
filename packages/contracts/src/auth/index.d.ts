/**
 * 认证域跨端契约。
 */

export type UserRole = 'consumer' | 'creator' | 'both' | 'admin';

export interface UserDto {
  id: string;
  /** 普通用户态只返回脱敏手机号，完整手机号不得下发到前端。 */
  phone: string;
  /** 与 phone 相同的显式脱敏展示字段，便于前端迁移到语义化命名。 */
  phone_masked: string;
  phone_verified: boolean;
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
