import type { FastifyReply, FastifyRequest } from 'fastify';

import { API_KEY_LIVE_PREFIX } from '@fateclaw/contracts/api-keys';

import {
  findActiveApiKeyByHash,
  hashApiKey,
  touchApiKeyLastUsed,
} from '#infrastructure/db';
import { getRuntimeEntitlementSnapshot } from '#modules/billing/entitlements';
import { getRedis } from '#infrastructure/redis';
import { fixedWindowRateLimit } from './rate-limit.js';

/**
 * 对外 API 单个 key 的调用频率上限（次/分钟）。
 *
 * @remarks All keys share this limit; see docs/open-api.md#rate-limits-and-errors.
 */
const OPEN_API_RATE_LIMIT_PER_MINUTE = 60;

/** OpenAI 兼容错误体的 type 取值（仅对外 /api/v1 域使用，与内部 {error:中文} 区分）。 */
export type OpenAiErrorType =
  | 'invalid_request_error'
  | 'insufficient_quota'
  | 'rate_limit_exceeded'
  | 'api_error';

/**
 * 以 OpenAI 风格错误体响应（对外 /api/v1 域统一格式）。
 *
 * @remarks OpenAI SDK 期望 `{ error: { message, type, code, param } }`，否则无法解析报错；
 * 因此整个对外域不沿用内部的 `{ error: "中文" }`。message 可为中文。
 */
export function sendOpenAiError(
  reply: FastifyReply,
  statusCode: number,
  message: string,
  type: OpenAiErrorType,
  code: string,
): FastifyReply {
  return reply.code(statusCode).send({
    error: { message, type, code, param: null },
  });
}

/** 从 Authorization 头解析 Bearer token；非法/缺失返回 null。 */
function parseBearerToken(
  header: string | string[] | undefined,
): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1]!.trim() : null;
}

/**
 * 节流更新 last_used_at：借 Redis SET NX EX 把 DB 写入限制到每 60s 最多一次。
 *
 * @remarks last_used_at 只用于展示，失败不影响鉴权主流程，故吞掉异常。
 */
async function touchLastUsedThrottled(keyId: string): Promise<void> {
  try {
    const mark = await getRedis().set(
      `openapi:lastused:${keyId}`,
      '1',
      'EX',
      60,
      'NX',
    );
    if (mark === 'OK') {
      await touchApiKeyLastUsed(keyId);
    }
  } catch {
    // 忽略：节流标记/写库失败不应阻断调用。
  }
}

/**
 * 对外开放 API（/api/v1/*）的鉴权 onRequest 钩子。
 *
 * 流程（仿 admin-routes 范式，叠加欠费门槛）：
 *   1. 解析 Authorization: Bearer fc_live_xxx；
 *   2. sha256 哈希反查有效（active）key；
 *   3. 校验未过期；
 *   4. 按 key 维度做调用频率限流（防单个 key 被滥用）；
 *   5. 校验钱包未欠费（专家模式已放开非会员，会员过期不再拦截、按加价计费，续费享原价）；
 *   6. 写入 request.apiKeyPrincipal 供下游取 userId；
 *   7. 节流更新 last_used_at。
 *
 * @remarks 任一步失败均以 OpenAI 风格错误体响应并中断（return reply）。
 *   不对「未知 key」做按来源 IP 的失败退避：对外 API 多为机器调用、常共享云出口 IP / CGNAT，
 *   按 IP 退避会把同出口某个坏 key 的失败算到全体头上，连累同 IP 的合法会员被锁死（参见
 *   auth-routes 当初为同一原因弃用 IP 退避、改按手机号的教训）。爆破防护由 256-bit key 空间
 *   本身 + 按 key 的固定窗口限流承担。
 */
export async function apiKeyAuthOnRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void | FastifyReply> {
  const token = parseBearerToken(request.headers['authorization']);
  if (!token || !token.startsWith(API_KEY_LIVE_PREFIX)) {
    return sendOpenAiError(
      reply,
      401,
      'API Key 缺失或格式无效',
      'invalid_request_error',
      'invalid_api_key',
    );
  }

  const row = await findActiveApiKeyByHash(hashApiKey(token));
  if (!row) {
    return sendOpenAiError(
      reply,
      401,
      'API Key 无效或已吊销',
      'invalid_request_error',
      'invalid_api_key',
    );
  }

  if (row.expires_at && row.expires_at.getTime() <= Date.now()) {
    return sendOpenAiError(
      reply,
      401,
      'API Key 已过期',
      'invalid_request_error',
      'invalid_api_key',
    );
  }

  // 按 key 维度的调用频率限流**上移到会员/欠费校验之前**：持合法 key 但会员过期/欠费者会被
  // 后面的 403/402 提前 return，若限流排在其后，他们将零限流地无限发起请求，每次都触发
  // getRuntimeEntitlementSnapshot 内部带行锁的写事务（expireUserBonusBalanceBefore），构成
  // 已鉴权的资源耗尽。故先用限流封顶所有携带合法 key 的请求，再做昂贵的权益快照。
  const callRate = await fixedWindowRateLimit(
    `openapi:${row.id}`,
    OPEN_API_RATE_LIMIT_PER_MINUTE,
    60,
  );
  if (!callRate.allowed) {
    reply.header('Retry-After', callRate.retryAfterSec);
    return sendOpenAiError(
      reply,
      callRate.unavailable ? 503 : 429,
      callRate.unavailable
        ? '限流服务暂时不可用，请稍后重试'
        : '调用过于频繁，请稍后再试',
      callRate.unavailable ? 'api_error' : 'rate_limit_exceeded',
      callRate.unavailable ? 'service_unavailable' : 'rate_limit_exceeded',
    );
  }

  // 专家模式已对非会员放开：持合法 key 者（含过期会员）均可调用，按非会员加价计费；
  // 仅保留欠费门禁（wallet.inArrears）。注：创建 key 仍是会员特权（api-keys-routes 未放开）。
  const entitlement = await getRuntimeEntitlementSnapshot(row.user_id);
  if (entitlement.wallet.inArrears) {
    return sendOpenAiError(
      reply,
      402,
      '账户积分欠费，请补充积分后继续调用',
      'insufficient_quota',
      'insufficient_quota',
    );
  }

  request.apiKeyPrincipal = {
    userId: row.user_id,
    apiKeyId: row.id,
    keyName: row.name,
  };
  void touchLastUsedThrottled(row.id);
}

/**
 * 取出鉴权钩子写入的调用方身份。
 *
 * @remarks onRequest 钩子已保证存在；此处仅做防御性兜底，理论上不会抛。
 */
export function requireApiKeyPrincipal(request: FastifyRequest): {
  userId: string;
  apiKeyId: string;
  keyName: string;
} {
  const principal = request.apiKeyPrincipal;
  if (!principal) {
    throw new Error('API Key principal 缺失：apiKeyAuthOnRequest 未生效');
  }
  return principal;
}
