/**
 * 图形验证码（字符 SVG + Redis challenge + HMAC 签名 token）
 *
 * 核心思路：
 * - 后端生成 4~5 位随机字符，渲染成扭曲的 SVG
 * - 答案和答案哈希都不发给前端，只发 { token, svg }
 * - token 结构：challengeId + "." + base64url(HMAC(challengeId))
 * - Redis 保存答案哈希、nonce、IP 指纹、过期时间和尝试次数
 * - 提交时后端验 HMAC、验 Redis 状态、验过期、验 IP、先计数再比对答案
 */

import crypto from 'node:crypto';

import { JWT_SECRET } from '../../infrastructure/config.js';
import { getRedis } from '../../infrastructure/redis.js';

const CAPTCHA_TTL_MS = 2 * 60 * 1000; // 2 分钟
const CAPTCHA_TTL_SECONDS = CAPTCHA_TTL_MS / 1000;
const MAX_ATTEMPTS = 3;
const NONCE_BYTES = 16;
const CHALLENGE_ID_BYTES = 16;
const CHARSET = 'abcdefghjkmnpqrstuvwxyz23456789'; // 去掉 0/O/1/l/i
const TEXT_LENGTH = 5;
const SVG_WIDTH = 140;
const SVG_HEIGHT = 48;

// ----------------------------------------------------------------------------
// Payload 类型与签名/验签
// ----------------------------------------------------------------------------

interface CaptchaState {
  /** sha256(answer_lower + nonce)，仅保存在 Redis，避免 token 可离线枚举答案。 */
  h: string;
  /** 每个 challenge 独立的盐，防止相同答案在 Redis 中产生相同哈希。 */
  n: string;
  /** 过期时间戳（毫秒），用于 Redis TTL 之外的防御性校验。 */
  e: number;
  /** sha256(clientIp).slice(0, 16)，绑定发起 challenge 的客户端 IP。 */
  ip: string;
}

function base64UrlEncode(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8');
  return b
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// 从 JWT_SECRET 派生独立的 captcha 子密钥，避免两个密码体制共享同一密钥
const CAPTCHA_HMAC_KEY = crypto
  .createHmac('sha256', JWT_SECRET)
  .update('captcha:v1')
  .digest();

function hmac(data: string): Buffer {
  return crypto.createHmac('sha256', CAPTCHA_HMAC_KEY).update(data).digest();
}

function challengeKey(challengeId: string): string {
  return `captcha:challenge:${challengeId}`;
}

function attemptsKey(challengeId: string): string {
  return `captcha:challenge:${challengeId}:attempts`;
}

function usedKey(challengeId: string): string {
  return `captcha:challenge:${challengeId}:used`;
}

function signToken(challengeId: string): string {
  const sig = base64UrlEncode(hmac(challengeId));
  return `${challengeId}.${sig}`;
}

/**
 * 验证 HMAC 签名并解析 challenge id。
 * @returns challenge id 或 null（签名不匹配/格式错误）
 */
function verifyToken(token: string): string | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;

  const challengeId = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  if (!/^[0-9a-f]{32}$/.test(challengeId)) return null;

  const expected = base64UrlEncode(hmac(challengeId));
  // 恒定时间比较，防 timing attack
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  return challengeId;
}

async function readCaptchaState(
  challengeId: string,
): Promise<CaptchaState | null> {
  const raw = await getRedis().get(challengeKey(challengeId));
  if (!raw) return null;

  try {
    const obj = JSON.parse(raw) as CaptchaState;
    if (
      typeof obj.h !== 'string' ||
      typeof obj.n !== 'string' ||
      typeof obj.e !== 'number' ||
      typeof obj.ip !== 'string'
    ) {
      return null;
    }
    return obj;
  } catch {
    return null;
  }
}

async function consumeCaptchaChallenge(
  challengeId: string,
  expiresAt: number,
): Promise<boolean> {
  const ttlSec = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
  const result = await getRedis().set(
    usedKey(challengeId),
    '1',
    'EX',
    ttlSec,
    'NX',
  );
  if (result !== 'OK') return false;

  await getRedis().del(challengeKey(challengeId), attemptsKey(challengeId));
  return true;
}

// ----------------------------------------------------------------------------
// SVG 渲染
// ----------------------------------------------------------------------------

function randInt(min: number, max: number): number {
  // 用 CSPRNG 取整数：验证码答案与视觉随机统一走 crypto，杜绝 Math.random 状态可预测。
  // crypto.randomInt 上界开区间，+1 还原 [min, max] 闭区间语义。
  return crypto.randomInt(min, max + 1);
}

function randColor(): string {
  // 暗色模式下仍可辨识的中性色调：亮度 55~70，饱和度 50~80
  const h = randInt(0, 360);
  const s = randInt(50, 80);
  const l = randInt(55, 72);
  return `hsl(${h}, ${s}%, ${l}%)`;
}

/**
 * 将字符串渲染成扭曲的 SVG 图片。
 * 每个字符：随机颜色、旋转 ±25°、Y 偏移 ±4px、字体大小 28~34。
 * 额外：2~3 条贝塞尔曲线干扰线 + 25 个随机噪点。
 */
function renderCaptchaSvg(text: string): string {
  const parts: string[] = [];

  // 背景
  parts.push(
    `<rect width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="transparent"/>`,
  );

  // 噪点
  for (let i = 0; i < 25; i++) {
    const cx = randInt(0, SVG_WIDTH);
    const cy = randInt(0, SVG_HEIGHT);
    const r = randInt(1, 2);
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${randColor()}" opacity="0.6"/>`,
    );
  }

  // 干扰线（2~3 条贝塞尔曲线）
  const lineCount = randInt(2, 3);
  for (let i = 0; i < lineCount; i++) {
    const x1 = randInt(0, SVG_WIDTH / 4);
    const y1 = randInt(0, SVG_HEIGHT);
    const cx1 = randInt(SVG_WIDTH / 4, (SVG_WIDTH * 3) / 4);
    const cy1 = randInt(0, SVG_HEIGHT);
    const cx2 = randInt(SVG_WIDTH / 4, (SVG_WIDTH * 3) / 4);
    const cy2 = randInt(0, SVG_HEIGHT);
    const x2 = randInt((SVG_WIDTH * 3) / 4, SVG_WIDTH);
    const y2 = randInt(0, SVG_HEIGHT);
    parts.push(
      `<path d="M${x1},${y1} C${cx1},${cy1} ${cx2},${cy2} ${x2},${y2}" stroke="${randColor()}" stroke-width="1.3" fill="none" opacity="0.55"/>`,
    );
  }

  // 字符
  const slotWidth = SVG_WIDTH / (text.length + 1);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const cx = slotWidth * (i + 1);
    const cy = SVG_HEIGHT / 2 + randInt(-4, 4) + 10;
    const rotate = randInt(-25, 25);
    const size = randInt(28, 34);
    parts.push(
      `<text x="${cx}" y="${cy}" font-family="monospace" font-size="${size}" font-weight="700" fill="${randColor()}" text-anchor="middle" transform="rotate(${rotate} ${cx} ${cy - 10})">${ch}</text>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}">${parts.join('')}</svg>`;
}

// ----------------------------------------------------------------------------
// 内部辅助：归一化 / 哈希 / IP 指纹
// ----------------------------------------------------------------------------

/** 把答案归一化为小写 + 去空白。用户输入 "7K M" 与 "7km" 视为一致。 */
function normalizeAnswer(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, '');
}

/** 对 "归一化答案 + nonce" 做 sha256，返回 hex。 */
function hashAnswer(normalized: string, nonce: string): string {
  return crypto
    .createHash('sha256')
    .update(`${normalized}|${nonce}`)
    .digest('hex');
}

/** 客户端 IP 指纹（16 字节 hex）。 */
function ipFingerprint(clientIp: string): string {
  return crypto
    .createHash('sha256')
    .update(clientIp)
    .digest('hex')
    .slice(0, 16);
}

// ----------------------------------------------------------------------------
// 对外 API
// ----------------------------------------------------------------------------

/**
 * 生成一个新的 captcha challenge。
 * @param clientIp Fastify request.ip —— 用于绑定 token
 */
export async function generateCaptcha(clientIp: string): Promise<{
  token: string;
  svg: string;
}> {
  // 随机抽取字符
  let text = '';
  for (let i = 0; i < TEXT_LENGTH; i++) {
    text += CHARSET[randInt(0, CHARSET.length - 1)];
  }

  const challengeId = crypto.randomBytes(CHALLENGE_ID_BYTES).toString('hex');
  const nonce = crypto.randomBytes(NONCE_BYTES).toString('hex');
  const normalized = normalizeAnswer(text);

  const state: CaptchaState = {
    h: hashAnswer(normalized, nonce),
    n: nonce,
    e: Date.now() + CAPTCHA_TTL_MS,
    ip: ipFingerprint(clientIp),
  };

  await getRedis().set(
    challengeKey(challengeId),
    JSON.stringify(state),
    'EX',
    CAPTCHA_TTL_SECONDS,
  );
  await getRedis().set(
    attemptsKey(challengeId),
    '0',
    'EX',
    CAPTCHA_TTL_SECONDS,
  );

  return {
    token: signToken(challengeId),
    svg: renderCaptchaSvg(text),
  };
}

/**
 * 验证用户提交的 captcha。
 *
 * 校验顺序按成本从低到高，任一步失败立即短路：
 *   1) HMAC 签名（verifyToken 已内部做恒定时间比较）
 *   2) Redis challenge 状态和过期时间
 *   3) IP 指纹绑定
 *   4) 先递增 attempts，再比对答案哈希，错误答案也会消耗机会
 *   5) 正确答案用 SET NX 原子消费 challenge，防止并发重放
 *
 * reason 字段仅路由层日志使用，不会发给前端。
 */
export async function verifyCaptcha(
  token: string,
  answer: string,
  clientIp: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const challengeId = verifyToken(token);
  if (!challengeId) return { ok: false, reason: 'bad_token' };

  const state = await readCaptchaState(challengeId);
  if (!state) return { ok: false, reason: 'expired_or_consumed' };

  if (state.e <= Date.now()) return { ok: false, reason: 'expired' };

  if (state.ip !== ipFingerprint(clientIp)) {
    return { ok: false, reason: 'ip_mismatch' };
  }

  const attempts = await getRedis().incr(attemptsKey(challengeId));
  if (attempts === 1) {
    await getRedis().expire(attemptsKey(challengeId), CAPTCHA_TTL_SECONDS);
  }
  if (attempts > MAX_ATTEMPTS) {
    return { ok: false, reason: 'too_many_attempts' };
  }

  const expectedHash = hashAnswer(normalizeAnswer(answer), state.n);
  if (state.h !== expectedHash) {
    return { ok: false, reason: 'wrong_answer' };
  }

  // SET NX EX 原子消费 challenge：并发正确提交只有一个请求能成功。
  const consumed = await consumeCaptchaChallenge(challengeId, state.e);
  if (!consumed) return { ok: false, reason: 'replay' };
  return { ok: true };
}
