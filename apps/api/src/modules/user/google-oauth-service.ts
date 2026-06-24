import crypto from 'crypto';

import {
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_REDIRECT_URI,
  JWT_SECRET,
} from '../../infrastructure/config.js';
import {
  createUserUsing,
  getDbPool,
  getUserByOAuthIdentityUsing,
  upsertOAuthIdentityUsing,
} from '../../infrastructure/db.js';
import { getRedis } from '../../infrastructure/redis.js';
import type { User } from '../../shared/types.js';

const GOOGLE_AUTHORIZATION_ENDPOINT =
  'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_TOKEN_INFO_ENDPOINT = 'https://oauth2.googleapis.com/tokeninfo';
const GOOGLE_OAUTH_PROVIDER = 'google';
const GOOGLE_OAUTH_SCOPE = 'openid email profile';
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

interface GoogleOAuthStatePayload {
  provider: typeof GOOGLE_OAUTH_PROVIDER;
  nonce: string;
  next: string;
  exp: number;
}

interface GoogleTokenResponse {
  id_token?: unknown;
  access_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

interface GoogleTokenInfoResponse {
  sub?: unknown;
  aud?: unknown;
  iss?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  picture?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export interface GoogleOAuthState {
  state: string;
  nonce: string;
  maxAgeSeconds: number;
}

export interface GoogleOAuthProfile {
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  raw: Record<string, unknown>;
}

function base64UrlEncodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function base64UrlDecodeJson<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
}

function signStatePayload(encodedPayload: string): string {
  return crypto
    .createHmac('sha256', JWT_SECRET)
    .update(encodedPayload)
    .digest('base64url');
}

function timingSafeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function normalizeNextPath(raw: string | null | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed || !trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return '/dashboard';
  }

  try {
    const parsed = new URL(trimmed, 'http://local');
    if (parsed.origin !== 'http://local') {
      return '/dashboard';
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/dashboard';
  }
}

function assertGoogleOAuthConfigured(): void {
  if (
    !GOOGLE_OAUTH_CLIENT_ID ||
    !GOOGLE_OAUTH_CLIENT_SECRET ||
    !GOOGLE_OAUTH_REDIRECT_URI
  ) {
    throw new Error('Google OAuth 尚未配置完整');
  }
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isEmailVerified(value: unknown): boolean {
  return value === true || value === 'true';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 创建 Google OAuth state。
 *
 * @param input.next 登录完成后的站内回跳路径。
 * @returns 签名 state、同源校验 nonce 和 cookie 有效期。
 */
export function createGoogleOAuthState(input: {
  next?: string | null;
}): GoogleOAuthState {
  const nonce = crypto.randomBytes(24).toString('base64url');
  const payload: GoogleOAuthStatePayload = {
    provider: GOOGLE_OAUTH_PROVIDER,
    nonce,
    next: normalizeNextPath(input.next),
    exp: Math.floor(Date.now() / 1000) + OAUTH_STATE_TTL_SECONDS,
  };
  const encodedPayload = base64UrlEncodeJson(payload);
  const signature = signStatePayload(encodedPayload);
  return {
    state: `${encodedPayload}.${signature}`,
    nonce,
    maxAgeSeconds: OAUTH_STATE_TTL_SECONDS,
  };
}

/**
 * 校验 Google OAuth state。
 *
 * @param state Google callback 原样带回的 state。
 * @param expectedNonce HttpOnly cookie 中保存的 nonce。
 * @returns 已校验并规范化的 state payload。
 */
export function verifyGoogleOAuthState(
  state: string,
  expectedNonce: string | null,
): GoogleOAuthStatePayload {
  if (!expectedNonce) {
    throw new Error('Google 登录状态已过期，请重试');
  }

  const [encodedPayload, signature] = state.split('.');
  if (!encodedPayload || !signature) {
    throw new Error('Google 登录状态无效，请重试');
  }

  const expectedSignature = signStatePayload(encodedPayload);
  if (!timingSafeEqualString(signature, expectedSignature)) {
    throw new Error('Google 登录状态无效，请重试');
  }

  const payload = base64UrlDecodeJson<GoogleOAuthStatePayload>(encodedPayload);
  if (
    payload.provider !== GOOGLE_OAUTH_PROVIDER ||
    payload.nonce !== expectedNonce ||
    payload.exp < Math.floor(Date.now() / 1000)
  ) {
    throw new Error('Google 登录状态已过期，请重试');
  }

  return {
    ...payload,
    next: normalizeNextPath(payload.next),
  };
}

/**
 * 构造 Google 授权跳转地址。
 *
 * @param state 已签名 OAuth state。
 * @returns 可直接 302 跳转的 Google 授权 URL。
 */
export function buildGoogleAuthorizationUrl(state: string): string {
  assertGoogleOAuthConfigured();

  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set('client_id', GOOGLE_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', GOOGLE_OAUTH_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_OAUTH_SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

/**
 * 用 Google 授权码换取并验证用户资料。
 *
 * @param code Google callback 返回的一次性授权码。
 * @returns 已验证 audience、issuer 和邮箱验证状态的 Google 用户资料。
 */
export async function exchangeGoogleCodeForProfile(
  code: string,
): Promise<GoogleOAuthProfile> {
  assertGoogleOAuthConfigured();

  const tokenResponse = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const tokenBody = (await tokenResponse.json().catch(() => ({}))) as
    | GoogleTokenResponse
    | Record<string, unknown>;
  if (!tokenResponse.ok) {
    throw new Error(
      stringField(tokenBody.error_description) ||
        stringField(tokenBody.error) ||
        'Google 登录失败',
    );
  }

  const idToken = stringField(tokenBody.id_token);
  if (!idToken) {
    throw new Error('Google 登录缺少身份令牌');
  }

  const tokenInfoUrl = new URL(GOOGLE_TOKEN_INFO_ENDPOINT);
  tokenInfoUrl.searchParams.set('id_token', idToken);
  const tokenInfoResponse = await fetch(tokenInfoUrl);
  const tokenInfo = (await tokenInfoResponse.json().catch(() => ({}))) as
    | GoogleTokenInfoResponse
    | Record<string, unknown>;
  if (!tokenInfoResponse.ok) {
    throw new Error(
      stringField(tokenInfo.error_description) ||
        stringField(tokenInfo.error) ||
        'Google 身份校验失败',
    );
  }

  const providerUserId = stringField(tokenInfo.sub);
  const audience = stringField(tokenInfo.aud);
  const issuer = stringField(tokenInfo.iss);
  const email = stringField(tokenInfo.email);
  const emailVerified = isEmailVerified(tokenInfo.email_verified);
  if (
    !providerUserId ||
    audience !== GOOGLE_OAUTH_CLIENT_ID ||
    (issuer !== 'accounts.google.com' &&
      issuer !== 'https://accounts.google.com') ||
    !email ||
    !emailVerified
  ) {
    throw new Error('Google 身份校验失败');
  }

  return {
    providerUserId,
    email,
    emailVerified,
    displayName: stringField(tokenInfo.name),
    avatarUrl: stringField(tokenInfo.picture),
    raw: asRecord(tokenInfo),
  };
}

/**
 * 查找或创建 Google OAuth 用户。
 *
 * @param profile 已验证的 Google 用户资料。
 * @returns 本地用户模型。
 * @remarks 使用事务级 advisory lock 保证同一个 Google sub 的并发 callback 不会重复建号。
 */
export async function findOrCreateGoogleOAuthUser(
  profile: GoogleOAuthProfile,
): Promise<User> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `${GOOGLE_OAUTH_PROVIDER}:${profile.providerUserId}`,
    ]);

    const existing = await getUserByOAuthIdentityUsing(
      client,
      GOOGLE_OAUTH_PROVIDER,
      profile.providerUserId,
    );
    if (existing) {
      await upsertOAuthIdentityUsing(client, {
        provider: GOOGLE_OAUTH_PROVIDER,
        providerUserId: profile.providerUserId,
        userId: existing.id,
        email: profile.email,
        emailVerified: profile.emailVerified,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        profileJson: profile.raw,
      });
      await client.query('COMMIT');
      return existing;
    }

    const now = new Date().toISOString();
    const user: User = {
      id: crypto.randomUUID(),
      phone: null,
      phone_verified: false,
      password_hash: null,
      role: 'consumer',
      purchased_coins: 0,
      bonus_coins: 0,
      reserved_coins: 0,
      created_at: now,
    };
    await createUserUsing(client, user);
    await upsertOAuthIdentityUsing(client, {
      provider: GOOGLE_OAUTH_PROVIDER,
      providerUserId: profile.providerUserId,
      userId: user.id,
      email: profile.email,
      emailVerified: profile.emailVerified,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      profileJson: profile.raw,
    });

    await client.query('COMMIT');
    return user;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// 一次性 OAuth 交换码：把已签发的站内 JWT 暂存 Redis，URL 只回传不敏感的 code，
// 前端再用 code 换回 token。避免 30 天 JWT 经浏览器历史 / Referer / 访问日志泄漏。
const OAUTH_EXCHANGE_KEY_PREFIX = 'oauth:exchange:';
const OAUTH_EXCHANGE_CODE_TTL_SECONDS = 60;

/**
 * 暂存 OAuth 登录签发的站内 JWT，返回一次性交换码（64 位十六进制）。
 *
 * @param token 已用 signAuthToken 签发的站内 JWT。
 * @returns 一次性交换码，60 秒内有效、单次消费。
 */
export async function storeOAuthExchangeToken(token: string): Promise<string> {
  const code = crypto.randomBytes(32).toString('hex');
  await getRedis().set(
    `${OAUTH_EXCHANGE_KEY_PREFIX}${code}`,
    token,
    'EX',
    OAUTH_EXCHANGE_CODE_TTL_SECONDS,
  );
  return code;
}

/**
 * 原子消费 OAuth 交换码（GET+DEL），返回对应站内 JWT。
 *
 * @param code 前端回传的一次性交换码。
 * @returns 对应 JWT；code 非法、已用、过期均返回 null。
 */
export async function consumeOAuthExchangeToken(
  code: string,
): Promise<string | null> {
  // 仅接受预期格式，避免任意输入参与 Redis key 构造。
  if (!/^[a-f0-9]{64}$/.test(code)) return null;
  const raw = await getRedis().eval(
    `
local value = redis.call("GET", KEYS[1])
if not value then
  return nil
end
redis.call("DEL", KEYS[1])
return value
`,
    1,
    `${OAUTH_EXCHANGE_KEY_PREFIX}${code}`,
  );
  return typeof raw === 'string' ? raw : null;
}
