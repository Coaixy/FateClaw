import type {
  AuthResponseDto,
  CaptchaChallengeDto,
  ChangePasswordRequestDto,
  ResetPasswordRequestDto,
  SendSMSCaptchaResponseDto,
  UserDto,
} from '@nanoclaw/contracts/auth';
import type { SuccessResponse } from '@nanoclaw/contracts/common';

import { requestJson } from '@/lib/http/client';

export type AuthResponse = AuthResponseDto;
export type User = UserDto;
export type CaptchaChallenge = CaptchaChallengeDto;
export type SendSMSCaptchaResponse = SendSMSCaptchaResponseDto;

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
  me: () => requestJson<User>('/api/auth/me'),
};
