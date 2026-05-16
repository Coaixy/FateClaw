import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  AuthResponseDto,
  CaptchaChallengeDto,
  UserDto,
} from '@nanoclaw/contracts/auth';

import {
  registerUser,
  loginUser,
  getUserSafe,
  changePassword,
  resetPasswordBySMS,
} from '../../modules/user/auth-service.js';
import {
  getSMSCaptchaPublicMessage,
  sendSMSCaptcha,
} from '../../modules/user/sms-captcha-service.js';
import {
  isValidMainlandChinaPhone,
  normalizePhoneNumber,
} from '../../modules/user/phone.js';
import { toUserDto } from '../../contracts-adapter/auth-contract.js';
import { generateCaptcha, verifyCaptcha } from './captcha.js';

const PhoneSchema = z
  .string()
  .trim()
  .min(1, '手机号不能为空')
  .transform((value) => normalizePhoneNumber(value))
  .refine(isValidMainlandChinaPhone, '手机号格式不正确');

const RegisterSchema = z.object({
  phoneNumber: PhoneSchema,
  password: z.string().min(8, '密码至少 8 位'),
  smsCaptchaCode: z.string().trim().min(1, '短信验证码不能为空'),
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

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/auth/captcha —— 获取新的图形验证码
  app.get('/captcha', async (request): Promise<CaptchaChallengeDto> => {
    return generateCaptcha(request.ip);
  });

  // POST /api/auth/send-sms-captcha
  // 发送短信验证码：type=1 注册，type=0 找回密码
  app.post('/send-sms-captcha', async (request, reply) => {
    const body = SendSMSCaptchaSchema.parse(request.body);

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
      });
      return { success: true };
    } catch (err) {
      request.log.error({ err }, 'send sms captcha failed');
      return reply.code(400).send({
        error: getSMSCaptchaPublicMessage(err),
      });
    }
  });

  // POST /api/auth/register
  app.post('/register', async (request, reply) => {
    const body = RegisterSchema.parse(request.body);

    try {
      const user = await registerUser(
        body.phoneNumber,
        body.password,
        body.smsCaptchaCode,
        request.ip,
      );
      const token = app.jwt.sign({ userId: user.id }, { expiresIn: '30d' });
      const safe: UserDto = toUserDto(user);
      const response: AuthResponseDto = { token, user: safe };
      return reply.code(201).send(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : '注册失败';
      return reply.code(400).send({ error: message });
    }
  });

  // POST /api/auth/login
  app.post('/login', async (request, reply) => {
    const body = LoginSchema.parse(request.body);

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
      const token = app.jwt.sign({ userId: user.id }, { expiresIn: '30d' });
      const safe: UserDto = toUserDto(user);
      const response: AuthResponseDto = { token, user: safe };
      return response;
    } catch (err) {
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
      const token = app.jwt.sign({ userId: user.id }, { expiresIn: '30d' });
      const safe: UserDto = toUserDto(user);
      const response: AuthResponseDto = { token, user: safe };
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : '重置密码失败';
      return reply.code(400).send({ error: message });
    }
  });
}
