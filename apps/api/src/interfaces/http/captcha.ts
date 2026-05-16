/**
 * 图形验证码（字符 SVG + HMAC 签名 token）
 *
 * 核心思路：
 * - 后端生成 4~5 位随机字符，渲染成扭曲的 SVG
 * - 答案不发给前端，只发 { token, svg }
 * - token 结构：base64url(payload) + "." + base64url(HMAC)
 *   payload = { h, n, e, ip }
 *     h  = sha256(answer_lower + n)  — 答案的盐哈希，防彩虹表
 *     n  = 16 字节随机 hex            — 一次性 nonce，防重放
 *     e  = 过期时间戳（毫秒）         — TTL 2 分钟
 *     ip = sha256(clientIp).slice    — IP 绑定，防 token 跨会话复用
 * - 提交时后端验 HMAC、验过期、验 IP、验 nonce 未用过、验答案哈希匹配
 */

import crypto from 'node:crypto';

import { JWT_SECRET } from '../../infrastructure/config.js';
import { getRedis } from '../../infrastructure/redis.js';

const CAPTCHA_TTL_MS = 2 * 60 * 1000; // 2 分钟
const NONCE_BYTES = 16;
const CHARSET = 'abcdefghjkmnpqrstuvwxyz23456789'; // 去掉 0/O/1/l/i
const TEXT_LENGTH = 5;
const SVG_WIDTH = 140;
const SVG_HEIGHT = 48;

/**
 * 标记 nonce 为已用并设置 TTL。Redis SET NX EX 原子写入，
 * 多实例部署下也能防止同一 nonce 被重复使用（替代历史的进程内 Map）。
 *
 * @returns true 表示首次写入（nonce 未被用过），false 表示已被使用
 */
async function markNonceUsed(
  nonce: string,
  expiresAt: number,
): Promise<boolean> {
  const ttlSec = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
  const result = await getRedis().set(
    `captcha:nonce:${nonce}`,
    '1',
    'EX',
    ttlSec,
    'NX',
  );
  return result === 'OK';
}

// ----------------------------------------------------------------------------
// Payload 类型与签名/验签
// ----------------------------------------------------------------------------

interface CaptchaPayload {
  /** sha256(answer_lower + nonce) */
  h: string;
  /** nonce，一次性使用 */
  n: string;
  /** 过期时间戳（毫秒） */
  e: number;
  /** sha256(clientIp).slice(0, 16) */
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

function base64UrlDecode(str: string): Buffer {
  const pad = 4 - (str.length % 4);
  const padded = str + (pad < 4 ? '='.repeat(pad) : '');
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// 从 JWT_SECRET 派生独立的 captcha 子密钥，避免两个密码体制共享同一密钥
const CAPTCHA_HMAC_KEY = crypto
  .createHmac('sha256', JWT_SECRET)
  .update('captcha:v1')
  .digest();

function hmac(data: string): Buffer {
  return crypto.createHmac('sha256', CAPTCHA_HMAC_KEY).update(data).digest();
}

function signToken(payload: CaptchaPayload): string {
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const sig = base64UrlEncode(hmac(payloadB64));
  return `${payloadB64}.${sig}`;
}

/**
 * 验证 HMAC 签名并解析 payload。
 * @returns payload 或 null（签名不匹配/格式错误）
 */
function verifyToken(token: string): CaptchaPayload | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;

  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const expected = base64UrlEncode(hmac(payloadB64));
  // 恒定时间比较，防 timing attack
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  try {
    const json = base64UrlDecode(payloadB64).toString('utf8');
    const obj = JSON.parse(json) as CaptchaPayload;
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

// ----------------------------------------------------------------------------
// SVG 渲染
// ----------------------------------------------------------------------------

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
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
export function generateCaptcha(clientIp: string): {
  token: string;
  svg: string;
} {
  // 随机抽取字符
  let text = '';
  for (let i = 0; i < TEXT_LENGTH; i++) {
    text += CHARSET[randInt(0, CHARSET.length - 1)];
  }

  const nonce = crypto.randomBytes(NONCE_BYTES).toString('hex');
  const normalized = normalizeAnswer(text);

  const payload: CaptchaPayload = {
    h: hashAnswer(normalized, nonce),
    n: nonce,
    e: Date.now() + CAPTCHA_TTL_MS,
    ip: ipFingerprint(clientIp),
  };

  return {
    token: signToken(payload),
    svg: renderCaptchaSvg(text),
  };
}

/**
 * 验证用户提交的 captcha。
 *
 * 校验顺序按成本从低到高，任一步失败立即短路：
 *   1) HMAC 签名（verifyToken 已内部做恒定时间比较）
 *   2) 过期时间
 *   3) IP 指纹绑定
 *   4) nonce 未被使用（先于答案比对：重放立即拒绝，不浪费哈希计算）
 *   5) 答案哈希匹配
 *
 * 成功后立即把 nonce 写入 usedNonces，防重放。
 * reason 字段仅路由层日志使用，不会发给前端。
 */
export async function verifyCaptcha(
  token: string,
  answer: string,
  clientIp: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const payload = verifyToken(token);
  if (!payload) return { ok: false, reason: 'bad_token' };

  if (payload.e <= Date.now()) return { ok: false, reason: 'expired' };

  if (payload.ip !== ipFingerprint(clientIp)) {
    return { ok: false, reason: 'ip_mismatch' };
  }

  const expectedHash = hashAnswer(normalizeAnswer(answer), payload.n);
  if (payload.h !== expectedHash) {
    return { ok: false, reason: 'wrong_answer' };
  }

  // SET NX EX 原子标记 nonce：返回 false 说明已被先前请求消费，判定为重放
  const inserted = await markNonceUsed(payload.n, payload.e);
  if (!inserted) return { ok: false, reason: 'replay' };
  return { ok: true };
}
