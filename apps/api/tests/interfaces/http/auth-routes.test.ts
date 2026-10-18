import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

const services = vi.hoisted(() => ({
  registerUser: vi.fn(),
  loginUser: vi.fn(),
  getUserSafe: vi.fn(),
  changePassword: vi.fn(),
  resetPasswordBySMS: vi.fn(),
  getCurrentUserVerifiedPhone: vi.fn(),
  resetCurrentUserPasswordBySMS: vi.fn(),
}));
const { sendSMSCaptcha, fixedWindowRateLimit } = vi.hoisted(() => ({
  sendSMSCaptcha: vi.fn(),
  fixedWindowRateLimit: vi.fn(async () => ({
    allowed: true,
    retryAfterSec: 0,
  })),
}));

vi.mock('#modules/user/auth-service', () => services);
vi.mock('#modules/user/sms-captcha-service', () => ({
  SMSCaptchaError: class extends Error {},
  getSMSCaptchaPublicMessage: vi.fn(),
  sendSMSCaptcha,
}));
vi.mock('#infrastructure/repositories/registration-invites-repository', () => ({
  assertRegistrationInviteValid: vi.fn(),
  createRegistrationInvite: vi.fn(),
  getRegistrationInvitePolicy: vi.fn(),
  getRegistrationInviteSummary: vi.fn(),
  listCompletedRechargeRefunds: vi.fn(),
  listRegistrationInvites: vi.fn(),
  recordCompletedRechargeRefund: vi.fn(),
  revokeRegistrationInvite: vi.fn(),
  saveRegistrationInvitePolicy: vi.fn(),
  updateRegistrationInviteAccount: vi.fn(),
}));
vi.mock('#interfaces/http/captcha', () => ({
  generateCaptcha: vi.fn(),
  verifyCaptcha: vi.fn(async () => ({ ok: true })),
}));
vi.mock('#interfaces/http/rate-limit', () => ({
  fixedWindowRateLimit,
  rateLimitCheck: vi.fn(async () => ({ allowed: true })),
  rateLimitClear: vi.fn(),
  rateLimitRecordFail: vi.fn(),
}));

import { authRoutes } from '#interfaces/http/auth-routes';

describe('authentication HTTP routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      return reply
        .code(error instanceof ZodError ? 400 : 500)
        .send({ error: error.message });
    });
    await app.register(fastifyJwt, {
      secret: 'synthetic-test-signing-secret-for-auth-routes',
    });
    await app.register(authRoutes, { prefix: '/api/auth' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it.each([
    { method: 'GET', url: '/api/auth/google/start?next=/clients' },
    { method: 'GET', url: '/api/auth/google/callback?code=code&state=state' },
    { method: 'POST', url: '/api/auth/oauth/exchange' },
  ] as const)('disables $method $url', async ({ method, url }) => {
    const response = await app.inject({
      method,
      url,
      ...(method === 'POST' ? { payload: { code: 'synthetic-code' } } : {}),
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.json()).not.toHaveProperty('token');
  });

  it.each(['register', 'send-sms-captcha'])(
    'requires an invitation before %s',
    async (path) => {
      services.registerUser.mockResolvedValue({
        id: 'synthetic-new-user',
        phone: '13800138000',
        phone_verified: true,
        password_hash: 'synthetic-hash',
        role: 'consumer',
        purchased_coins: 0,
        bonus_coins: 0,
        reserved_coins: 0,
        created_at: '2026-10-17T00:00:00Z',
      });
      const response = await app.inject({
        method: 'POST',
        url: `/api/auth/${path}`,
        payload: {
          type: 1,
          phoneNumber: '13800138000',
          password: 'password123',
          smsCaptchaCode: '123456',
          captcha_token: 'synthetic',
          captcha_answer: 'abcde',
        },
      });
      expect(response.statusCode).toBe(400);
      expect(services.registerUser).not.toHaveBeenCalled();
      expect(sendSMSCaptcha).not.toHaveBeenCalled();
    },
  );

  it('passes the registration invitation to SMS validation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/send-sms-captcha',
      payload: {
        type: 1,
        phoneNumber: '+86 13800138000',
        captcha_token: 'synthetic-captcha',
        captcha_answer: 'abcde',
        inviteCode: ' 0123456789ABCDEF01234567 ',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(sendSMSCaptcha).toHaveBeenCalledWith({
      type: 1,
      phoneNumber: '13800138000',
      clientIp: '127.0.0.1',
      inviteCode: '0123456789ABCDEF01234567',
    });
  });

  it('keeps SMS password recovery available without an invitation', async () => {
    const user = {
      id: 'existing-phone-user',
      phone: '13800138000',
      phone_verified: true,
      password_hash: 'synthetic-hash',
      role: 'consumer',
      purchased_coins: 0,
      bonus_coins: 0,
      reserved_coins: 0,
      created_at: '2026-10-17T00:00:00Z',
    };
    services.resetPasswordBySMS.mockResolvedValueOnce(user);
    const smsResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/send-sms-captcha',
      payload: {
        type: 0,
        phoneNumber: '13800138000',
        captcha_token: 'synthetic-captcha',
        captcha_answer: 'abcde',
      },
    });
    const resetResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: {
        phoneNumber: '13800138000',
        newPassword: 'new-password',
        smsCaptchaCode: '123456',
      },
    });

    expect(smsResponse.statusCode).toBe(200);
    expect(resetResponse.statusCode).toBe(200);
    expect(sendSMSCaptcha).toHaveBeenCalledWith({
      type: 0,
      phoneNumber: user.phone,
      clientIp: '127.0.0.1',
      inviteCode: undefined,
    });
    expect(services.resetPasswordBySMS).toHaveBeenCalledWith({
      phone: user.phone,
      nextPassword: 'new-password',
      smsCaptchaCode: '123456',
      clientIp: '127.0.0.1',
    });
    expect(fixedWindowRateLimit).not.toHaveBeenCalled();
    expect(app.jwt.verify(resetResponse.json().token)).toMatchObject({
      userId: user.id,
    });
  });

  it.each([
    {
      path: 'register',
      status: 201,
      payload: {
        phoneNumber: '+86 13800138000',
        password: 'test-password',
        smsCaptchaCode: '123456',
        inviteCode: '0123456789ABCDEF01234567',
      },
    },
    {
      path: 'login',
      status: 200,
      payload: {
        phone: '+86 13800138000',
        password: 'test-password',
        captcha_token: 'synthetic-captcha',
        captcha_answer: 'abcde',
      },
    },
  ])('keeps phone $path available', async ({ path, status, payload }) => {
    const user = {
      id: 'phone-user',
      phone: '13800138000',
      phone_verified: true,
      password_hash: 'synthetic-hash',
      role: 'consumer',
      purchased_coins: 0,
      bonus_coins: 0,
      reserved_coins: 0,
      created_at: '2026-10-17T00:00:00.000Z',
    };
    services.registerUser.mockResolvedValue(user);
    services.loginUser.mockResolvedValue(user);

    const response = await app.inject({
      method: 'POST',
      url: `/api/auth/${path}`,
      payload,
    });

    expect(response.statusCode).toBe(status);
    expect(app.jwt.verify(response.json().token)).toMatchObject({
      userId: user.id,
      authTokenVersion: 0,
    });
    expect(response.json().user).toMatchObject({
      id: user.id,
      phone: '138****8000',
      phone_verified: true,
    });
    expect(response.json().user).not.toHaveProperty('password_hash');
    if (path === 'register') {
      expect(services.registerUser).toHaveBeenCalledWith(
        user.phone,
        payload.password,
        '123456',
        '127.0.0.1',
        '0123456789ABCDEF01234567',
      );
    } else {
      expect(services.loginUser).toHaveBeenCalledWith(
        user.phone,
        payload.password,
      );
    }
  });
});
