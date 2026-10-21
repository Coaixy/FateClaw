import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authApi } from '../../../features/auth/api';

import { requestJson } from '@/lib/http/client';

vi.mock('@/lib/http/client', () => ({
  requestJson: vi.fn(),
}));

const requestJsonMock = vi.mocked(requestJson);

describe('authApi', () => {
  beforeEach(() => {
    requestJsonMock.mockReset();
    requestJsonMock.mockResolvedValue({});
  });

  it('includes the invitation when registering a phone account', async () => {
    await authApi.register(
      '13800138000',
      'password123',
      '123456',
      'test-invitation',
    );

    expect(requestJsonMock).toHaveBeenCalledWith('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        phoneNumber: '13800138000',
        password: 'password123',
        smsCaptchaCode: '123456',
        inviteCode: 'test-invitation',
      }),
    });
  });

  it('sends the invitation with registration SMS requests', async () => {
    await authApi.sendSMSCaptcha(
      1,
      '13800138000',
      'image-token',
      'abcd',
      'test-invitation',
    );

    expect(requestJsonMock).toHaveBeenCalledWith('/api/auth/send-sms-captcha', {
      method: 'POST',
      body: JSON.stringify({
        type: 1,
        phoneNumber: '13800138000',
        captcha_token: 'image-token',
        captcha_answer: 'abcd',
        inviteCode: 'test-invitation',
      }),
    });
  });

  it.each([undefined, '', '   '])(
    'omits an empty invitation (%s) from signup and registration SMS',
    async (inviteCode) => {
      await authApi.register(
        '13800138000',
        'password123',
        '123456',
        inviteCode,
      );
      await authApi.sendSMSCaptcha(
        1,
        '13800138000',
        'image-token',
        'abcd',
        inviteCode,
      );

      expect(requestJsonMock).toHaveBeenCalledWith('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          phoneNumber: '13800138000',
          password: 'password123',
          smsCaptchaCode: '123456',
        }),
      });
      expect(requestJsonMock).toHaveBeenCalledWith(
        '/api/auth/send-sms-captcha',
        {
          method: 'POST',
          body: JSON.stringify({
            type: 1,
            phoneNumber: '13800138000',
            captcha_token: 'image-token',
            captcha_answer: 'abcd',
          }),
        },
      );
    },
  );

  it('keeps password-recovery SMS requests independent from invitations', async () => {
    await authApi.sendSMSCaptcha(0, '13800138000', 'image-token', 'abcd');

    expect(requestJsonMock).toHaveBeenCalledWith('/api/auth/send-sms-captcha', {
      method: 'POST',
      body: JSON.stringify({
        type: 0,
        phoneNumber: '13800138000',
        captcha_token: 'image-token',
        captcha_answer: 'abcd',
      }),
    });
  });
});
