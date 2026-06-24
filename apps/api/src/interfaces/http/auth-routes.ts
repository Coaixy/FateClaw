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
} from '../../modules/user/auth-service.js';
import {
  buildGoogleAuthorizationUrl,
  consumeOAuthExchangeToken,
  createGoogleOAuthState,
  exchangeGoogleCodeForProfile,
  findOrCreateGoogleOAuthUser,
  storeOAuthExchangeToken,
  verifyGoogleOAuthState,
} from '../../modules/user/google-oauth-service.js';
import {
  getSMSCaptchaPublicMessage,
  sendSMSCaptcha,
} from '../../modules/user/sms-captcha-service.js';
import {
  isValidMainlandChinaPhone,
  normalizePhoneNumber,
} from '../../modules/user/phone.js';
import { toUserDto } from '../../contracts-adapter/auth-contract.js';
import { OAUTH_WEB_BASE_URL } from '../../infrastructure/config.js';
import { generateCaptcha, verifyCaptcha } from './captcha.js';
import {
  rateLimitCheck,
  rateLimitClear,
  rateLimitRecordFail,
} from './rate-limit.js';

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

const SendCurrentUserSMSCaptchaSchema = z.object({
  captcha_token: z.string().min(1),
  captcha_answer: z.string().min(1),
});

const ResetCurrentUserPasswordSchema = z.object({
  newPassword: z.string().min(8, '新密码至少 8 位'),
  smsCaptchaCode: z.string().trim().min(1, '短信验证码不能为空'),
});

const GoogleOAuthStartSchema = z.object({
  next: z.string().max(2048).optional(),
});

const GoogleOAuthCallbackSchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

function signAuthToken(app: FastifyInstance, user: AuthTokenUser): string {
  const payload = {
    userId: user.id,
    authTokenVersion: user.auth_token_version ?? 0,
  };
  return app.jwt.sign(payload, { expiresIn: '30d' });
}

const GOOGLE_OAUTH_NONCE_COOKIE = 'fateclaw_google_oauth_nonce';

function parseCookieHeader(
  value: string | string[] | undefined,
): Record<string, string> {
  const header = Array.isArray(value) ? value.join(';') : value;
  if (!header) return {};

  return Object.fromEntries(
    header
      .split(';')
      .map((part) => {
        const separatorIndex = part.indexOf('=');
        if (separatorIndex < 0) return null;
        const key = part.slice(0, separatorIndex).trim();
        const rawValue = part.slice(separatorIndex + 1).trim();
        if (!key) return null;
        try {
          return [key, decodeURIComponent(rawValue)] as const;
        } catch {
          return [key, rawValue] as const;
        }
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry)),
  );
}

function oauthNonceCookie(value: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${GOOGLE_OAUTH_NONCE_COOKIE}=${encodeURIComponent(value)}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearOAuthNonceCookie(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${GOOGLE_OAUTH_NONCE_COOKIE}=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function oauthCallbackRedirectUrl(input: {
  code?: string;
  next: string;
  error?: string;
}): string {
  if (!OAUTH_WEB_BASE_URL) {
    throw new Error('WEB_BASE_URL 未配置');
  }
  const url = new URL('/login/oauth-callback', OAUTH_WEB_BASE_URL);
  url.searchParams.set('next', input.next);
  // 只回传一次性交换码（60s、单次消费），不再把长期 JWT 暴露在 URL 里。
  if (input.code) {
    url.searchParams.set('code', input.code);
  }
  if (input.error) {
    url.searchParams.set('error', input.error);
  }
  return url.toString();
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/auth/captcha —— 获取新的图形验证码
  app.get('/captcha', async (request): Promise<CaptchaChallengeDto> => {
    return await generateCaptcha(request.ip);
  });

  // GET /api/auth/google/start —— 发起 Google OAuth 登录
  app.get('/google/start', async (request, reply) => {
    const query = GoogleOAuthStartSchema.parse(request.query);
    const oauthState = createGoogleOAuthState({
      next: query.next,
    });
    const authorizationUrl = buildGoogleAuthorizationUrl(oauthState.state);

    reply.header(
      'Set-Cookie',
      oauthNonceCookie(oauthState.nonce, oauthState.maxAgeSeconds),
    );
    return reply.code(302).header('Location', authorizationUrl).send();
  });

  // GET /api/auth/google/callback —— Google 回调后签发站内 JWT
  app.get('/google/callback', async (request, reply) => {
    const query = GoogleOAuthCallbackSchema.parse(request.query);
    const cookies = parseCookieHeader(request.headers.cookie);
    let next = '/dashboard';

    reply.header('Set-Cookie', clearOAuthNonceCookie());

    try {
      if (query.error) {
        throw new Error('Google 登录已取消');
      }
      if (!query.code || !query.state) {
        throw new Error('Google 登录参数不完整');
      }

      const state = verifyGoogleOAuthState(
        query.state,
        cookies[GOOGLE_OAUTH_NONCE_COOKIE] ?? null,
      );
      next = state.next;
      const profile = await exchangeGoogleCodeForProfile(query.code);
      const user = await findOrCreateGoogleOAuthUser(profile);
      const token = signAuthToken(app, user);
      // JWT 不进 URL：暂存 Redis 换一次性 code，前端再用 code 调 /oauth/exchange 取回。
      const code = await storeOAuthExchangeToken(token);
      return reply
        .code(302)
        .header('Location', oauthCallbackRedirectUrl({ code, next }))
        .send();
    } catch (err) {
      request.log.warn({ err }, 'google oauth callback failed');
      const message = err instanceof Error ? err.message : 'Google 登录失败';
      return reply
        .code(302)
        .header(
          'Location',
          oauthCallbackRedirectUrl({
            next,
            error: message,
          }),
        )
        .send();
    }
  });

  // POST /api/auth/oauth/exchange —— 用一次性交换码换回 OAuth 登录签发的站内 JWT。
  // OAuth 回调只把 code 放进 URL，真正的长期 JWT 经此端点单次取回，不经浏览器历史/日志。
  app.post('/oauth/exchange', async (request, reply) => {
    const body = z.object({ code: z.string() }).parse(request.body);
    const token = await consumeOAuthExchangeToken(body.code);
    if (!token) {
      return reply
        .code(400)
        .send({ error: '登录凭证无效或已过期，请重新发起登录' });
    }
    return { token };
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

    try {
      const user = await registerUser(
        body.phoneNumber,
        body.password,
        body.smsCaptchaCode,
        request.ip,
      );
      const token = signAuthToken(app, user);
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
