import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAssertRegistrationInviteValid,
  mockGetUserByPhone,
  mockLoggerError,
  mockLoggerWarn,
  mockRedisEval,
  mockRedisExpire,
  mockRedisIncr,
  mockRedisSet,
  mockRedisTtl,
  mockSendSmsVerifyCode,
} = vi.hoisted(() => ({
  mockAssertRegistrationInviteValid: vi.fn(),
  mockGetUserByPhone: vi.fn(),
  mockLoggerError: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockRedisEval: vi.fn(),
  mockRedisExpire: vi.fn(),
  mockRedisIncr: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisTtl: vi.fn(),
  mockSendSmsVerifyCode: vi.fn(),
}));

vi.mock('node:module', () => ({
  createRequire: vi.fn(() => (id: string): unknown => {
    if (id === '@alicloud/credentials') {
      return {
        Config: class CredentialConfig {
          constructor(public readonly options: unknown) {}
        },
        default: class Credential {
          constructor(public readonly config: unknown) {}
        },
      };
    }

    if (id === '@alicloud/dypnsapi20170525') {
      return {
        CheckSmsVerifyCodeRequest: class CheckSmsVerifyCodeRequest {
          constructor(public readonly options: unknown) {}
        },
        SendSmsVerifyCodeRequest: class SendSmsVerifyCodeRequest {
          constructor(public readonly options: unknown) {}
        },
        default: class DypnsapiClient {
          checkSmsVerifyCode = vi.fn();
          sendSmsVerifyCode = mockSendSmsVerifyCode;

          constructor(public readonly config: unknown) {}
        },
      };
    }

    if (id === '@alicloud/openapi-client') {
      return {
        Config: class OpenApiConfig {
          constructor(public readonly options: unknown) {}
        },
      };
    }

    throw new Error(`Unexpected require: ${id}`);
  }),
}));

vi.mock('../../../src/infrastructure/config.js', () => ({
  ALIYUN_SMS_ACCESS_KEY_ID: 'access-key-id',
  ALIYUN_SMS_ACCESS_KEY_SECRET: 'access-key-secret',
  ALIYUN_SMS_ENDPOINT: 'https://dypnsapi.aliyuncs.com',
}));

vi.mock('../../../src/infrastructure/db.js', () => ({
  getUserByPhone: mockGetUserByPhone,
}));

vi.mock(
  '../../../src/infrastructure/repositories/registration-invites-repository.js',
  () => ({
    assertRegistrationInviteValid: mockAssertRegistrationInviteValid,
  }),
);

vi.mock('../../../src/infrastructure/logger.js', () => ({
  logger: {
    error: mockLoggerError,
    warn: mockLoggerWarn,
  },
}));

vi.mock('../../../src/infrastructure/redis.js', () => ({
  getRedis: vi.fn(() => ({
    eval: mockRedisEval,
    expire: mockRedisExpire,
    incr: mockRedisIncr,
    set: mockRedisSet,
    ttl: mockRedisTtl,
  })),
}));

import { sendSMSCaptcha } from '../../../src/modules/user/sms-captcha-service.js';

const PHONE_NUMBER = '13800138000';
const CLIENT_IP = '203.0.113.7';
const INVITE_CODE = '0123456789ABCDEF01234567';

function successfulProviderResponse() {
  return {
    body: {
      code: 'OK',
      success: true,
    },
  };
}

describe('sendSMSCaptcha', () => {
  beforeEach(() => {
    mockAssertRegistrationInviteValid.mockReset();
    mockGetUserByPhone.mockReset();
    mockLoggerError.mockReset();
    mockLoggerWarn.mockReset();
    mockRedisEval.mockReset();
    mockRedisExpire.mockReset();
    mockRedisIncr.mockReset();
    mockRedisSet.mockReset();
    mockRedisTtl.mockReset();
    mockSendSmsVerifyCode.mockReset();

    mockAssertRegistrationInviteValid.mockResolvedValue({
      valid: true,
      expires_at: '2026-10-24T00:00:00Z',
    });
    mockGetUserByPhone.mockResolvedValue(null);
    mockRedisEval.mockResolvedValue(1);
    mockRedisExpire.mockResolvedValue(1);
    mockRedisIncr.mockResolvedValue(1);
    mockRedisSet.mockResolvedValue('OK');
    mockRedisTtl.mockResolvedValue(60);
    mockSendSmsVerifyCode.mockResolvedValue(successfulProviderResponse());
  });

  it('uses Redis SET NX EX before calling the SMS provider', async () => {
    await sendSMSCaptcha({
      clientIp: CLIENT_IP,
      phoneNumber: PHONE_NUMBER,
      type: 1,
      inviteCode: INVITE_CODE,
    });

    expect(mockAssertRegistrationInviteValid).toHaveBeenCalledWith(INVITE_CODE);
    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringMatching(/^sms:captcha:send-lock:/),
      expect.any(String),
      'EX',
      180,
      'NX',
    );
    expect(mockRedisSet.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendSmsVerifyCode.mock.invocationCallOrder[0],
    );
    expect(mockSendSmsVerifyCode).toHaveBeenCalledTimes(1);
  });

  it('prevents concurrent sends for the same phone with one lock winner', async () => {
    let lockTaken = false;
    mockRedisSet.mockImplementation(async () => {
      if (lockTaken) return null;
      lockTaken = true;
      return 'OK';
    });

    const results = await Promise.allSettled([
      sendSMSCaptcha({
        clientIp: CLIENT_IP,
        phoneNumber: PHONE_NUMBER,
        type: 1,
        inviteCode: INVITE_CODE,
      }),
      sendSMSCaptcha({
        clientIp: CLIENT_IP,
        phoneNumber: PHONE_NUMBER,
        type: 1,
        inviteCode: INVITE_CODE,
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(mockGetUserByPhone).toHaveBeenCalledTimes(1);
    expect(mockSendSmsVerifyCode).toHaveBeenCalledTimes(1);
  });

  it('short-circuits when the send lock already exists', async () => {
    mockRedisSet.mockResolvedValueOnce(null);

    await expect(
      sendSMSCaptcha({
        clientIp: CLIENT_IP,
        phoneNumber: PHONE_NUMBER,
        type: 1,
        inviteCode: INVITE_CODE,
      }),
    ).rejects.toMatchObject({
      publicMessage: '3分钟内只能发送一次短信验证码',
    });

    expect(mockGetUserByPhone).not.toHaveBeenCalled();
    expect(mockSendSmsVerifyCode).not.toHaveBeenCalled();
  });

  it('shortens the owned send lock when the provider rejects the request', async () => {
    mockSendSmsVerifyCode.mockResolvedValueOnce({
      body: {
        code: 'ProviderError',
        message: 'provider rejected',
        success: false,
      },
    });

    await expect(
      sendSMSCaptcha({
        clientIp: CLIENT_IP,
        phoneNumber: PHONE_NUMBER,
        type: 1,
        inviteCode: INVITE_CODE,
      }),
    ).rejects.toMatchObject({
      publicMessage: '短信服务暂时不可用，请稍后再试',
    });

    const [lockKey, token] = mockRedisSet.mock.calls[0];
    expect(mockRedisEval).toHaveBeenCalledTimes(1);
    expect(mockRedisEval.mock.calls[0]?.slice(1)).toEqual([
      1,
      lockKey,
      token,
      10,
    ]);
  });

  it('rejects an invalid registration invite before Redis or SMS provider usage', async () => {
    const invalidInvite = new Error('邀请码无效、已使用、已过期或暂不可用');
    mockAssertRegistrationInviteValid.mockRejectedValueOnce(invalidInvite);

    await expect(
      sendSMSCaptcha({
        clientIp: CLIENT_IP,
        phoneNumber: PHONE_NUMBER,
        type: 1,
        inviteCode: 'invalid-invite',
      }),
    ).rejects.toBe(invalidInvite);

    expect(mockAssertRegistrationInviteValid).toHaveBeenCalledWith(
      'invalid-invite',
    );
    for (const redisOperation of [
      mockRedisEval,
      mockRedisExpire,
      mockRedisIncr,
      mockRedisSet,
      mockRedisTtl,
    ]) {
      expect(redisOperation).not.toHaveBeenCalled();
    }
    expect(mockGetUserByPhone).not.toHaveBeenCalled();
    expect(mockSendSmsVerifyCode).not.toHaveBeenCalled();
  });

  it('allows password recovery SMS without an invitation', async () => {
    mockGetUserByPhone.mockResolvedValueOnce({ id: 'synthetic-existing-user' });

    await sendSMSCaptcha({
      clientIp: CLIENT_IP,
      phoneNumber: PHONE_NUMBER,
      type: 0,
    });

    expect(mockAssertRegistrationInviteValid).not.toHaveBeenCalled();
    expect(mockSendSmsVerifyCode).toHaveBeenCalledOnce();
  });
});
