import type {
  AuthResponseDto,
  CaptchaChallengeDto,
  ChangePasswordRequestDto,
  ResetPasswordRequestDto,
  SendSMSCaptchaResponseDto,
  UserDto,
} from '@fateclaw/contracts/auth';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import { createAuthScopedInFlightCache } from '@/lib/auth-scoped-cache';
import { requestJson } from '@/lib/http/client';

export type AuthResponse = AuthResponseDto;
export type User = UserDto;
export type CaptchaChallenge = CaptchaChallengeDto;
export type SendSMSCaptchaResponse = SendSMSCaptchaResponseDto;

const meRequestCache = createAuthScopedInFlightCache<User>();

/**
 * 清理当前用户信息的 in-flight 请求缓存。
 *
 * @returns 无返回值。
 */
export function clearAuthCache() {
  meRequestCache.clear();
}

export const authApi = {
  captcha: () => requestJson<CaptchaChallenge>('/api/auth/captcha'),
  sendSMSCaptcha: (
    type: 0 | 1,
    phoneNumber: string,
    captchaToken: string,
    captchaAnswer: string,
  ) =>
    requestJson<SendSMSCaptchaResponse>('/api/auth/send-sms-captcha', {
      method: 'POST',
      body: JSON.stringify({
        type,
        phoneNumber,
        captcha_token: captchaToken,
        captcha_answer: captchaAnswer,
      }),
    }),
  register: (phone: string, password: string, smsCaptchaCode: string) =>
    requestJson<AuthResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        phoneNumber: phone,
        password,
        smsCaptchaCode,
      }),
    }),
  login: (
    phone: string,
    password: string,
    captchaToken: string,
    captchaAnswer: string,
  ) =>
    requestJson<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        phone,
        password,
        captcha_token: captchaToken,
        captcha_answer: captchaAnswer,
      }),
    }),
  changePassword: (currentPassword: string, nextPassword: string) =>
    requestJson<SuccessResponse>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: nextPassword,
      } satisfies ChangePasswordRequestDto),
    }),
  resetPassword: (
    phone: string,
    nextPassword: string,
    smsCaptchaCode: string,
  ) =>
    requestJson<AuthResponse>('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({
        phoneNumber: phone,
        newPassword: nextPassword,
        smsCaptchaCode,
      } satisfies ResetPasswordRequestDto),
    }),
  sendCurrentUserSMSCaptcha: (captchaToken: string, captchaAnswer: string) =>
    requestJson<SendSMSCaptchaResponse>('/api/auth/me/send-sms-captcha', {
      method: 'POST',
      body: JSON.stringify({
        captcha_token: captchaToken,
        captcha_answer: captchaAnswer,
      }),
    }),
  resetCurrentUserPassword: (nextPassword: string, smsCaptchaCode: string) =>
    requestJson<AuthResponse>('/api/auth/me/reset-password', {
      method: 'POST',
      body: JSON.stringify({
        newPassword: nextPassword,
        smsCaptchaCode,
      }),
    }),
  me: () => meRequestCache.get(() => requestJson<User>('/api/auth/me')),
};
