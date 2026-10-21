import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  AuthResponseDto,
  CaptchaChallengeDto,
  UserDto,
} from '@fateclaw/contracts/auth';

import {
  registerUser,
  loginUser,
  getUserSafe,
  changePassword,
  resetPasswordBySMS,
  getCurrentUserVerifiedPhone,
  resetCurrentUserPasswordBySMS,
} from '#modules/user/auth-service';
import {
  getSMSCaptchaPublicMessage,
  sendSMSCaptcha,
  SMSCaptchaError,
} from '#modules/user/sms-captcha-service';
import {
  isValidMainlandChinaPhone,
  normalizePhoneNumber,
} from '#modules/user/phone';
import { toUserDto } from '#contracts-adapter/auth-contract';
import { generateCaptcha, verifyCaptcha } from './captcha.js';
import {
  rateLimitCheck,
  rateLimitClear,
  rateLimitRecordFail,
} from './rate-limit.js';
import {
  RegistrationInviteCodeSchema,
  allowRegistrationAttempt,
} from './registration-invite-routes.js';
import { RegistrationInviteError } from '#modules/user/registration-invite-errors';

type AuthTokenUser = {
  id: string;
  auth_token_version?: number;
};

const PhoneSchema = z
  .string()
  .trim()
  .min(1, '手机号不能为空')
  .transform((value) => normalizePhoneNumber(value))
  .refine(isValidMainlandChinaPhone, '手机号格式不正确');

const OptionalRegistrationInviteCodeSchema = z.preprocess(
  (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
  RegistrationInviteCodeSchema.optional(),
);

const RegisterSchema = z.object({
  phoneNumber: PhoneSchema,
  password: z.string().min(8, '密码至少 8 位'),
  smsCaptchaCode: z.string().trim().min(1, '短信验证码不能为空'),
  inviteCode: OptionalRegistrationInviteCodeSchema,
});

const LoginSchema = z.object({
  phone: PhoneSchema,
  password: z.string(),
  captcha_token: z.string().min(1),
  captcha_answer: z.string().min(1),
});

const SendSMSCaptchaSchema = z.object({
  type: z.union([z.literal(0), z.literal(1)]),
  phoneNumber: PhoneSchema,
  captcha_token: z.string().min(1),
  captcha_answer: z.string().min(1),
  inviteCode: OptionalRegistrationInviteCodeSchema,
});

const ChangePasswordSchema = z.object({
  current_password: z.string().min(1, '当前密码不能为空'),
  new_password: z.string().min(8, '新密码至少 8 位'),
});

const ResetPasswordSchema = z.object({
  phoneNumber: PhoneSchema,
  newPassword: z.string().min(8, '新密码至少 8 位'),
  smsCaptchaCode: z.string().trim().min(1, '短信验证码不能为空'),
});

const SendCurrentUserSMSCaptchaSchema = z.object({
  captcha_token: z.string().min(1),
  captcha_answer: z.string().min(1),
});

const ResetCurrentUserPasswordSchema = z.object({
  newPassword: z.string().min(8, '新密码至少 8 位'),
  smsCaptchaCode: z.string().trim().min(1, '短信验证码不能为空'),
});

function signAuthToken(app: FastifyInstance, user: AuthTokenUser): string {
  const payload = {
    userId: user.id,
    authTokenVersion: user.auth_token_version ?? 0,
  };
  return app.jwt.sign(payload, { expiresIn: '30d' });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/auth/captcha —— 获取新的图形验证码
  app.get('/captcha', async (request): Promise<CaptchaChallengeDto> => {
    return await generateCaptcha(request.ip);
  });

  // POST /api/auth/send-sms-captcha
  // 发送短信验证码：type=1 注册，type=0 找回密码
  app.post('/send-sms-captcha', async (request, reply) => {
    const body = SendSMSCaptchaSchema.parse(request.body);
    if (body.type === 1 && !(await allowRegistrationAttempt(request.ip, reply)))
      return;

    const cap = await verifyCaptcha(
      body.captcha_token,
      body.captcha_answer,
      request.ip,
    );
    if (!cap.ok) {
      request.log.warn(
        { reason: cap.reason },
        'captcha failed on send sms captcha',
      );
      return reply.code(400).send({ error: '验证码错误' });
    }

    try {
      await sendSMSCaptcha({
        type: body.type,
        phoneNumber: body.phoneNumber,
        clientIp: request.ip,
        inviteCode: body.type === 1 ? body.inviteCode : undefined,
      });
      return { success: true };
    } catch (err) {
      request.log.error({ err }, 'send sms captcha failed');
      return reply.code(400).send({
        error: getSMSCaptchaPublicMessage(err),
      });
    }
  });

  // POST /api/auth/me/send-sms-captcha
  // 登录态找回密码验证码：手机号由后端按当前用户解析，避免完整手机号下发前端。
  app.post('/me/send-sms-captcha', async (request, reply) => {
    await request.requireAuth();
    const body = SendCurrentUserSMSCaptchaSchema.parse(request.body);

    const cap = await verifyCaptcha(
      body.captcha_token,
      body.captcha_answer,
      request.ip,
    );
    if (!cap.ok) {
      request.log.warn(
        { reason: cap.reason },
        'captcha failed on current user send sms captcha',
      );
      return reply.code(400).send({ error: '验证码错误' });
    }

    try {
      const phone = await getCurrentUserVerifiedPhone(request.user.userId);
      await sendSMSCaptcha({
        type: 0,
        phoneNumber: phone,
        clientIp: request.ip,
      });
      return { success: true };
    } catch (err) {
      request.log.error({ err }, 'send current user sms captcha failed');
      return reply.code(400).send({
        error: getSMSCaptchaPublicMessage(err),
      });
    }
  });

  // POST /api/auth/register
  app.post('/register', async (request, reply) => {
    const body = RegisterSchema.parse(request.body);
    if (!(await allowRegistrationAttempt(request.ip, reply))) return;

    try {
      const user = await registerUser(
        body.phoneNumber,
        body.password,
        body.smsCaptchaCode,
        request.ip,
        body.inviteCode,
      );
      const token = signAuthToken(app, user);
      const safe: UserDto = toUserDto(user);
      const response: AuthResponseDto = { token, user: safe };
      return reply.code(201).send(response);
    } catch (err) {
      if (err instanceof RegistrationInviteError)
        return reply.code(err.statusCode).send({ error: err.message });
      if (err instanceof SMSCaptchaError)
        return reply
          .code(err.exposeToUser ? 400 : 503)
          .send({ error: err.publicMessage });
      throw err;
    }
  });

  // POST /api/auth/login
  app.post('/login', async (request, reply) => {
    const body = LoginSchema.parse(request.body);

    // 在线密码爆破限流：按手机号做指数退避（与 admin 密钥校验同款 rate-limit）。
    // 仅按手机号、不按 IP——在反代未正确配置 trustProxy 时 request.ip 可能坍缩成
    // 单一代理 IP，按 IP 记失败会把单个攻击者的失败算到全体头上、制造全站登录锁定。
    // 按手机号只节流对单一账户的猜测，无连带误伤，且 10 分钟封顶后自动恢复。
    const loginRateKey = `login:${normalizePhoneNumber(body.phone)}`;
    const limit = await rateLimitCheck(loginRateKey);
    if (!limit.allowed) {
      return reply
        .code(429)
        .header('Retry-After', Math.ceil((limit.retryAfterMs ?? 1000) / 1000))
        .send({ error: '登录尝试过于频繁，请稍后再试' });
    }

    const cap = await verifyCaptcha(
      body.captcha_token,
      body.captcha_answer,
      request.ip,
    );
    if (!cap.ok) {
      request.log.warn({ reason: cap.reason }, 'captcha failed on login');
      return reply.code(400).send({ error: '验证码错误' });
    }

    try {
      const user = await loginUser(body.phone, body.password);
      const token = signAuthToken(app, user);
      await rateLimitClear(loginRateKey); // 登录成功清除该手机号的退避状态
      const safe: UserDto = toUserDto(user);
      const response: AuthResponseDto = { token, user: safe };
      return response;
    } catch (err) {
      await rateLimitRecordFail(loginRateKey); // 失败记一次，触发指数退避
      const message = err instanceof Error ? err.message : '登录失败';
      return reply.code(401).send({ error: message });
    }
  });

  // GET /api/auth/me
  app.get('/me', async (request, reply) => {
    await request.requireAuth();
    const safe = await getUserSafe(request.user.userId);
    if (!safe) {
      return reply.code(404).send({ error: '用户不存在' });
    }
    return safe;
  });

  // POST /api/auth/change-password
  // 登录态修改密码：必须校验当前密码，避免被已登录设备静默改密。
  app.post('/change-password', async (request, reply) => {
    await request.requireAuth();
    const body = ChangePasswordSchema.parse(request.body);

    try {
      await changePassword({
        userId: request.user.userId,
        currentPassword: body.current_password,
        nextPassword: body.new_password,
      });
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : '修改密码失败';
      return reply.code(400).send({ error: message });
    }
  });

  // POST /api/auth/reset-password
  // 短信验证码重置密码：成功后直接签发新 token，便于用户继续当前会话。
  app.post('/reset-password', async (request, reply) => {
    const body = ResetPasswordSchema.parse(request.body);

    try {
      const user = await resetPasswordBySMS({
        phone: body.phoneNumber,
        nextPassword: body.newPassword,
        smsCaptchaCode: body.smsCaptchaCode,
        clientIp: request.ip,
      });
      const token = signAuthToken(app, user);
      const safe: UserDto = toUserDto(user);
      const response: AuthResponseDto = { token, user: safe };
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : '重置密码失败';
      return reply.code(400).send({ error: message });
    }
  });

  // POST /api/auth/me/reset-password
  // 登录态短信验证码重置密码：完整手机号只在后端读取。
  app.post('/me/reset-password', async (request, reply) => {
    await request.requireAuth();
    const body = ResetCurrentUserPasswordSchema.parse(request.body);

    try {
      const user = await resetCurrentUserPasswordBySMS({
        userId: request.user.userId,
        nextPassword: body.newPassword,
        smsCaptchaCode: body.smsCaptchaCode,
        clientIp: request.ip,
      });
      const token = signAuthToken(app, user);
      const safe: UserDto = toUserDto(user);
      const response: AuthResponseDto = { token, user: safe };
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : '重置密码失败';
      return reply.code(400).send({ error: message });
    }
  });
}
