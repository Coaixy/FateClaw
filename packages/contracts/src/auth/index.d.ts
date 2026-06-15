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
  invite_code?: string | null;
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
