import crypto from 'node:crypto';
import { createRequire } from 'node:module';

import {
  ALIYUN_SMS_ACCESS_KEY_ID,
  ALIYUN_SMS_ACCESS_KEY_SECRET,
  ALIYUN_SMS_ENDPOINT,
} from '../../infrastructure/config.js';
import { getRedis } from '../../infrastructure/redis.js';
import { getUserByPhone } from '../../infrastructure/db.js';
import { logger } from '../../infrastructure/logger.js';
import { normalizePhoneNumber, isValidMainlandChinaPhone } from './phone.js';
import { assertRegistrationInviteValid } from '../../infrastructure/repositories/registration-invites-repository.js';
import { RegistrationInviteError } from './registration-invite-errors.js';

const SMS_CAPTCHA_TTL_MINUTES = 3;
const SMS_CAPTCHA_TTL_SECONDS = SMS_CAPTCHA_TTL_MINUTES * 60;
const SMS_CAPTCHA_SEND_INTERVAL_SECONDS = 60;
const SMS_CAPTCHA_SEND_FAILURE_COOLDOWN_SECONDS = 10;
const SMS_SEND_IP_WINDOW_MINUTES = 10;
const SMS_SEND_IP_WINDOW_SECONDS = SMS_SEND_IP_WINDOW_MINUTES * 60;
const SMS_SEND_IP_LIMIT = 8;
const SMS_COUNTRY_CODE = '86';
const SMS_SIGN_NAME = '速通互联验证服务';
const SMS_TEMPLATE_CODE = '100001';
const SMS_TEMPLATE_PARAM = JSON.stringify({
  code: '##code##',
  min: String(SMS_CAPTCHA_TTL_MINUTES),
});
const SMS_VERIFY_PHONE_FAIL_LIMIT = 5;
const SMS_VERIFY_IP_FAIL_LIMIT = 12;
const SMS_VERIFY_FAIL_WINDOW_MINUTES = 30;
const SMS_VERIFY_FAIL_WINDOW_SECONDS = SMS_VERIFY_FAIL_WINDOW_MINUTES * 60;
const SMS_VERIFY_LOCK_MINUTES = 30;
const SMS_VERIFY_LOCK_SECONDS = SMS_VERIFY_LOCK_MINUTES * 60;

type SMSCaptchaType = 0 | 1;

interface SMSCaptchaSendLock {
  key: string;
  token: string;
}

const require = createRequire(import.meta.url);
const CredentialModule =
  require('@alicloud/credentials') as typeof import('@alicloud/credentials');
const DypnsapiModule =
  require('@alicloud/dypnsapi20170525') as typeof import('@alicloud/dypnsapi20170525');
const OpenApiModule =
  require('@alicloud/openapi-client') as typeof import('@alicloud/openapi-client');

const Credential = CredentialModule.default;
const CredentialConfig = CredentialModule.Config;
const DypnsapiClient = DypnsapiModule.default;
const CheckSmsVerifyCodeRequest = DypnsapiModule.CheckSmsVerifyCodeRequest;
const SendSmsVerifyCodeRequest = DypnsapiModule.SendSmsVerifyCodeRequest;
const OpenApiConfig = OpenApiModule.Config;

type SMSClient = InstanceType<typeof DypnsapiClient>;

let smsClient: SMSClient | null = null;

export class SMSCaptchaError extends Error {
  constructor(
    message: string,
    public readonly publicMessage: string,
    public readonly exposeToUser = true,
  ) {
    super(message);
    this.name = 'SMSCaptchaError';
  }
}

function userVisibleSMSCaptchaError(message: string): SMSCaptchaError {
  return new SMSCaptchaError(message, message, true);
}

function internalSMSCaptchaError(
  message: string,
  publicMessage = '短信服务暂时不可用，请稍后再试',
): SMSCaptchaError {
  return new SMSCaptchaError(message, publicMessage, false);
}

export function getSMSCaptchaPublicMessage(error: unknown): string {
  if (error instanceof RegistrationInviteError) return error.message;
  if (error instanceof SMSCaptchaError) {
    return error.publicMessage;
  }
  return '短信服务暂时不可用，请稍后再试';
}

function normalizeAliyunEndpoint(raw: string): string {
  return raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function getSMSCaptchaSendLockKey(phoneNumber: string): string {
  return `sms:captcha:send-lock:${hashPhoneNumber(phoneNumber)}`;
}

function hashClientIp(clientIp: string): string {
  return crypto
    .createHash('sha256')
    .update(clientIp)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Redis key 只保留手机号哈希，避免把原始手机号直接落到基础设施层。
 */
function hashPhoneNumber(phoneNumber: string): string {
  return crypto
    .createHash('sha256')
    .update(phoneNumber)
    .digest('hex')
    .slice(0, 16);
}

/**
 * 日志只记录脱敏手机号，便于排障但不暴露完整号码。
 */
function maskPhoneNumber(phoneNumber: string): string {
  if (phoneNumber.length < 7) return '***';
  return `${phoneNumber.slice(0, 3)}****${phoneNumber.slice(-4)}`;
}

function getSMSCaptchaSendIpWindowKey(ipHash: string): string {
  return `sms:captcha:send:ip-window:${ipHash}`;
}

function getSMSCaptchaVerifyPhoneFailKey(phoneNumber: string): string {
  return `sms:captcha:verify:phone-fails:${hashPhoneNumber(phoneNumber)}`;
}

function getSMSCaptchaVerifyIpFailKey(ipHash: string): string {
  return `sms:captcha:verify:ip-fails:${ipHash}`;
}

function getSMSCaptchaVerifyPhoneLockKey(phoneNumber: string): string {
  return `sms:captcha:verify:phone-lock:${hashPhoneNumber(phoneNumber)}`;
}

function getSMSCaptchaVerifyIpLockKey(ipHash: string): string {
  return `sms:captcha:verify:ip-lock:${ipHash}`;
}

async function getLockRetrySeconds(lockKey: string): Promise<number | null> {
  const ttl = await getRedis().ttl(lockKey);
  if (ttl <= 0) {
    return null;
  }
  return ttl;
}

async function acquireSMSCaptchaSendLock(
  phoneNumber: string,
): Promise<SMSCaptchaSendLock | null> {
  const key = getSMSCaptchaSendLockKey(phoneNumber);
  const token = crypto.randomUUID();
  const result = await getRedis().set(
    key,
    token,
    'EX',
    SMS_CAPTCHA_TTL_SECONDS,
    'NX',
  );

  if (result !== 'OK') {
    return null;
  }
  return { key, token };
}

async function setOwnedSMSCaptchaSendLockTtl(
  lock: SMSCaptchaSendLock,
  ttlSeconds: number,
): Promise<void> {
  // 只调整当前请求持有的锁，避免慢请求回滚时误删新请求已抢到的锁。
  await Promise.resolve()
    .then(() =>
      getRedis().eval(
        `
        if redis.call('GET', KEYS[1]) ~= ARGV[1] then
          return 0
        end
        local ttl = tonumber(ARGV[2])
        if ttl <= 0 then
          return redis.call('DEL', KEYS[1])
        end
        return redis.call('EXPIRE', KEYS[1], ttl)
        `,
        1,
        lock.key,
        lock.token,
        ttlSeconds,
      ),
    )
    .catch((error: unknown) => {
      logger.warn(
        { err: error, lockKey: lock.key, ttlSeconds },
        '更新短信发送锁 TTL 失败',
      );
    });
}

async function assertSMSCaptchaSendAllowed(clientIp: string): Promise<void> {
  const redis = getRedis();
  const ipHash = hashClientIp(clientIp);
  const ipWindowKey = getSMSCaptchaSendIpWindowKey(ipHash);
  const attempts = await redis.incr(ipWindowKey);
  if (attempts === 1) {
    await redis.expire(ipWindowKey, SMS_SEND_IP_WINDOW_SECONDS);
  }

  if (attempts > SMS_SEND_IP_LIMIT) {
    const retryAfter = await redis.ttl(ipWindowKey);
    throw userVisibleSMSCaptchaError(
      retryAfter > 0
        ? `${SMS_SEND_IP_WINDOW_MINUTES}分钟内短信请求次数过多，请在 ${retryAfter} 秒后再试`
        : '短信请求过于频繁，请稍后再试',
    );
  }
}

async function assertSMSCaptchaVerifyAllowed(
  phoneNumber: string,
  clientIp: string,
): Promise<void> {
  const ipHash = hashClientIp(clientIp);
  const phoneLockTtl = await getLockRetrySeconds(
    getSMSCaptchaVerifyPhoneLockKey(phoneNumber),
  );
  if (phoneLockTtl) {
    throw userVisibleSMSCaptchaError(
      `该手机号验证码错误次数过多，已锁定 ${SMS_VERIFY_LOCK_MINUTES} 分钟，请在 ${phoneLockTtl} 秒后再试`,
    );
  }

  const ipLockTtl = await getLockRetrySeconds(
    getSMSCaptchaVerifyIpLockKey(ipHash),
  );
  if (ipLockTtl) {
    throw userVisibleSMSCaptchaError(
      `当前 IP 尝试次数过多，已锁定 ${SMS_VERIFY_LOCK_MINUTES} 分钟，请在 ${ipLockTtl} 秒后再试`,
    );
  }
}

async function recordSMSCaptchaVerifyFail(
  phoneNumber: string,
  clientIp: string,
): Promise<{
  phoneLocked: boolean;
  ipLocked: boolean;
}> {
  const redis = getRedis();
  const ipHash = hashClientIp(clientIp);
  const phoneFailsKey = getSMSCaptchaVerifyPhoneFailKey(phoneNumber);
  const ipFailsKey = getSMSCaptchaVerifyIpFailKey(ipHash);
  const phoneLockKey = getSMSCaptchaVerifyPhoneLockKey(phoneNumber);
  const ipLockKey = getSMSCaptchaVerifyIpLockKey(ipHash);

  const [phoneFails, ipFails] = await Promise.all([
    redis.incr(phoneFailsKey),
    redis.incr(ipFailsKey),
  ]);
  await Promise.all([
    redis.expire(phoneFailsKey, SMS_VERIFY_FAIL_WINDOW_SECONDS),
    redis.expire(ipFailsKey, SMS_VERIFY_FAIL_WINDOW_SECONDS),
  ]);

  // 手机号和 IP 分别独立计数，只要任一维度触发阈值就进入硬锁定。
  if (phoneFails >= SMS_VERIFY_PHONE_FAIL_LIMIT) {
    await redis.set(phoneLockKey, '1', 'EX', SMS_VERIFY_LOCK_SECONDS);
  }
  if (ipFails >= SMS_VERIFY_IP_FAIL_LIMIT) {
    await redis.set(ipLockKey, '1', 'EX', SMS_VERIFY_LOCK_SECONDS);
  }

  return {
    phoneLocked: phoneFails >= SMS_VERIFY_PHONE_FAIL_LIMIT,
    ipLocked: ipFails >= SMS_VERIFY_IP_FAIL_LIMIT,
  };
}

async function clearSMSCaptchaVerifyFailState(
  phoneNumber: string,
  clientIp: string,
): Promise<void> {
  const redis = getRedis();
  const ipHash = hashClientIp(clientIp);
  await redis.del(
    getSMSCaptchaVerifyPhoneFailKey(phoneNumber),
    getSMSCaptchaVerifyIpFailKey(ipHash),
    getSMSCaptchaVerifyPhoneLockKey(phoneNumber),
    getSMSCaptchaVerifyIpLockKey(ipHash),
  );
}

// 统一复用一个 SDK client，避免每次请求都重复构造凭据对象。
function getSMSClient(): SMSClient {
  if (smsClient) {
    return smsClient;
  }

  if (
    !ALIYUN_SMS_ACCESS_KEY_ID ||
    !ALIYUN_SMS_ACCESS_KEY_SECRET ||
    !ALIYUN_SMS_ENDPOINT
  ) {
    throw internalSMSCaptchaError('短信服务未配置');
  }

  const credential = new Credential(
    new CredentialConfig({
      type: 'access_key',
      accessKeyId: ALIYUN_SMS_ACCESS_KEY_ID,
      accessKeySecret: ALIYUN_SMS_ACCESS_KEY_SECRET,
    }),
  );
  const config = new OpenApiConfig({
    credential,
    endpoint: normalizeAliyunEndpoint(ALIYUN_SMS_ENDPOINT),
    connectTimeout: 5_000,
    readTimeout: 10_000,
  });

  smsClient = new DypnsapiClient(config);
  return smsClient;
}

function getAliyunErrorDetail(error: unknown): {
  code?: string;
  message?: string;
  requestId?: string;
  recommend?: string;
  accessDeniedDetail?: string;
} {
  if (!error || typeof error !== 'object') {
    return {};
  }

  const detail = error as {
    code?: string;
    message?: string;
    data?: Record<string, unknown>;
  };
  const data = detail.data ?? {};
  return {
    code:
      detail.code ||
      (typeof data.Code === 'string' ? data.Code : undefined) ||
      (typeof data.code === 'string' ? data.code : undefined),
    message:
      detail.message ||
      (typeof data.Message === 'string' ? data.Message : undefined) ||
      (typeof data.message === 'string' ? data.message : undefined),
    requestId:
      (typeof data.RequestId === 'string' ? data.RequestId : undefined) ||
      (typeof data.requestId === 'string' ? data.requestId : undefined),
    recommend:
      (typeof data.Recommend === 'string' ? data.Recommend : undefined) ||
      (typeof data.recommend === 'string' ? data.recommend : undefined),
    accessDeniedDetail:
      (typeof data.AccessDeniedDetail === 'string'
        ? data.AccessDeniedDetail
        : undefined) ||
      (typeof data.accessDeniedDetail === 'string'
        ? data.accessDeniedDetail
        : undefined),
  };
}

async function sendAliyunSMS(phoneNumber: string): Promise<void> {
  const client = getSMSClient();
  const outId = crypto.randomUUID();
  const phoneMasked = maskPhoneNumber(phoneNumber);

  let response;
  try {
    response = await client.sendSmsVerifyCode(
      new SendSmsVerifyCodeRequest({
        phoneNumber,
        countryCode: SMS_COUNTRY_CODE,
        signName: SMS_SIGN_NAME,
        templateCode: SMS_TEMPLATE_CODE,
        templateParam: SMS_TEMPLATE_PARAM,
        codeLength: 6,
        codeType: 1,
        duplicatePolicy: 1,
        interval: SMS_CAPTCHA_SEND_INTERVAL_SECONDS,
        validTime: SMS_CAPTCHA_TTL_SECONDS,
        outId,
      }),
    );
  } catch (error) {
    const detail = getAliyunErrorDetail(error);
    logger.error(
      {
        err: error,
        phoneMasked,
        outId,
        providerCode: detail.code,
        providerMessage: detail.message,
        providerRequestId: detail.requestId,
        providerRecommend: detail.recommend,
        providerAccessDeniedDetail: detail.accessDeniedDetail,
      },
      'sms provider request failed',
    );
    throw internalSMSCaptchaError('短信服务请求失败');
  }

  const body = response.body;
  if (!body?.success || body.code !== 'OK') {
    logger.error(
      {
        phoneMasked,
        outId,
        providerCode: body?.code,
        providerMessage: body?.message,
        providerRequestId: body?.requestId || body?.model?.requestId,
        providerAccessDeniedDetail: body?.accessDeniedDetail,
      },
      'sms provider rejected request',
    );
    throw internalSMSCaptchaError(
      body?.message || body?.code || '短信发送失败',
    );
  }
}

function isVerifyResultPass(verifyResult: string | undefined): boolean {
  return verifyResult === 'PASS';
}

async function verifyAliyunSMSCaptcha(
  phoneNumber: string,
  smsCaptchaCode: string,
): Promise<void> {
  const client = getSMSClient();
  const outId = crypto.randomUUID();
  const phoneMasked = maskPhoneNumber(phoneNumber);

  let response;
  try {
    response = await client.checkSmsVerifyCode(
      new CheckSmsVerifyCodeRequest({
        phoneNumber,
        countryCode: SMS_COUNTRY_CODE,
        verifyCode: smsCaptchaCode,
        caseAuthPolicy: 1,
        outId,
      }),
    );
  } catch (error) {
    const detail = getAliyunErrorDetail(error);
    logger.error(
      {
        err: error,
        phoneMasked,
        outId,
        providerCode: detail.code,
        providerMessage: detail.message,
        providerRequestId: detail.requestId,
        providerRecommend: detail.recommend,
        providerAccessDeniedDetail: detail.accessDeniedDetail,
      },
      'sms captcha verify request failed',
    );
    throw internalSMSCaptchaError('短信验证码校验失败');
  }

  const body = response.body;
  if (!body?.success || body.code !== 'OK') {
    logger.error(
      {
        phoneMasked,
        outId,
        providerCode: body?.code,
        providerMessage: body?.message,
        providerVerifyResult: body?.model?.verifyResult,
        providerAccessDeniedDetail: body?.accessDeniedDetail,
      },
      'sms captcha verify rejected by provider',
    );
    throw internalSMSCaptchaError(
      body?.message || body?.code || '短信验证码校验失败',
    );
  }

  if (!isVerifyResultPass(body.model?.verifyResult)) {
    throw userVisibleSMSCaptchaError('短信验证码错误');
  }
}

export async function sendSMSCaptcha(input: {
  type: SMSCaptchaType;
  phoneNumber: string;
  clientIp: string;
  inviteCode?: string;
}): Promise<void> {
  const phoneNumber = normalizePhoneNumber(input.phoneNumber);
  if (!isValidMainlandChinaPhone(phoneNumber)) {
    throw userVisibleSMSCaptchaError('手机号格式不正确');
  }

  if (input.type === 1) {
    await assertRegistrationInviteValid(input.inviteCode ?? '');
  }

  await assertSMSCaptchaSendAllowed(input.clientIp);

  const sendLock = await acquireSMSCaptchaSendLock(phoneNumber);
  if (!sendLock) {
    throw userVisibleSMSCaptchaError(
      `${SMS_CAPTCHA_TTL_MINUTES}分钟内只能发送一次短信验证码`,
    );
  }

  try {
    const user = await getUserByPhone(phoneNumber);
    if (input.type === 1 && user) {
      throw userVisibleSMSCaptchaError('手机号已注册');
    }
    if (input.type === 0 && !user) {
      throw userVisibleSMSCaptchaError('手机号未注册');
    }
  } catch (error) {
    await setOwnedSMSCaptchaSendLockTtl(sendLock, 0);
    throw error;
  }

  try {
    await sendAliyunSMS(phoneNumber);
  } catch (error) {
    await setOwnedSMSCaptchaSendLockTtl(
      sendLock,
      SMS_CAPTCHA_SEND_FAILURE_COOLDOWN_SECONDS,
    );
    throw error;
  }

  // 验证码正文完全交给阿里云托管，本地只保留发送冷却锁，避免并发重复下发。
  await setOwnedSMSCaptchaSendLockTtl(sendLock, SMS_CAPTCHA_TTL_SECONDS);
}

export async function verifySMSCaptcha(
  phoneNumber: string,
  smsCaptchaCode: string,
  clientIp: string,
): Promise<string> {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  if (!isValidMainlandChinaPhone(normalizedPhone)) {
    throw userVisibleSMSCaptchaError('手机号格式不正确');
  }

  await assertSMSCaptchaVerifyAllowed(normalizedPhone, clientIp);

  try {
    await verifyAliyunSMSCaptcha(normalizedPhone, smsCaptchaCode);
  } catch (error) {
    if (
      error instanceof SMSCaptchaError &&
      error.exposeToUser &&
      error.publicMessage === '短信验证码错误'
    ) {
      const state = await recordSMSCaptchaVerifyFail(normalizedPhone, clientIp);
      if (state.phoneLocked) {
        throw userVisibleSMSCaptchaError(
          `该手机号验证码错误次数过多，已锁定 ${SMS_VERIFY_LOCK_MINUTES} 分钟，请稍后再试`,
        );
      }
      if (state.ipLocked) {
        throw userVisibleSMSCaptchaError(
          `当前 IP 尝试次数过多，已锁定 ${SMS_VERIFY_LOCK_MINUTES} 分钟，请稍后再试`,
        );
      }
    }
    throw error;
  }

  await clearSMSCaptchaVerifyFailState(normalizedPhone, clientIp);
  return normalizedPhone;
}
