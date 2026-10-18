import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  commitDirectPaipanForOwnedUser,
  listDirectPaipanCatalogForOwnedUser,
  previewDirectPaipanForOwnedUser,
} from '#modules/chat/paipan-service';
import { reverseGanzhiForPaipan } from '#modules/chat/ganzhi-reverse-service';
import { getUserById } from '#infrastructure/db';
import { fixedWindowRateLimit } from './rate-limit.js';

/** 免登录排盘端点（preview / ganzhi-reverse）的每分钟按 IP 限流额度。 */
const PAIPAN_PUBLIC_RATE_LIMIT_PER_MIN = 60;

/**
 * 免登录排盘端点的按 IP 固定窗口限流 preHandler。
 *
 * preview 每次写一个 30 分钟 TTL 的 Redis 预览记录、ganzhi-reverse 触发真实计算，
 * 游客可达且原本无限流，需防高频刷量堆爆 Redis / 占用算力。
 */
async function paipanPublicRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { allowed, retryAfterSec, unavailable } = await fixedWindowRateLimit(
    `paipan:${request.ip}`,
    PAIPAN_PUBLIC_RATE_LIMIT_PER_MIN,
    60,
  );
  if (!allowed) {
    reply.header('Retry-After', String(retryAfterSec));
    await reply
      .code(unavailable ? 503 : 429)
      .send({
        error: unavailable
          ? '限流服务暂时不可用，请稍后重试'
          : '请求过于频繁，请稍后再试',
      });
  }
}

function isJwtVerificationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === 'string' &&
    (code.startsWith('FST_JWT') || code.startsWith('FAST_JWT'))
  );
}

async function resolveOptionalUserId(
  request: FastifyRequest,
): Promise<string | undefined> {
  if (!request.headers.authorization) {
    return undefined;
  }

  try {
    // 预览仍允许游客使用；只有请求携带有效 token 时，才把预览绑定到用户。
    await request.jwtVerify();
    if (typeof request.user.authTokenVersion !== 'number') {
      return undefined;
    }
    const user = await getUserById(request.user.userId);
    if (
      !user ||
      (user.auth_token_version ?? 0) !== request.user.authTokenVersion
    ) {
      return undefined;
    }
    return request.user.userId;
  } catch (error) {
    if (isJwtVerificationError(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * 注册排盘 HTTP 路由。
 * catalog 和 preview 保持公共访问；commit 必须登录后才能写入会话。
 */
export async function paipanRoutes(app: FastifyInstance): Promise<void> {
  app.get('/catalog', async (_request, reply) => {
    const result = await listDirectPaipanCatalogForOwnedUser();
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  app.post<{
    Body: {
      skill?: string;
      input?: Record<string, unknown>;
      client_id?: string;
    };
  }>(
    '/preview',
    { preHandler: paipanPublicRateLimit },
    async (request, reply) => {
      const skill = request.body?.skill?.trim();
      const input = request.body?.input;
      const clientId = request.body?.client_id?.trim() || undefined;

      if (!skill) {
        return reply.code(400).send({ error: '缺少 skill' });
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return reply.code(400).send({ error: '缺少有效的 input' });
      }

      const userId = await resolveOptionalUserId(request);
      const result = await previewDirectPaipanForOwnedUser({
        userId,
        skill,
        input,
        clientId,
      });
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );

  app.post<{
    Body: unknown;
  }>(
    '/ganzhi-reverse',
    { preHandler: paipanPublicRateLimit },
    async (request, reply) => {
      const result = reverseGanzhiForPaipan(request.body);
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );

  app.post<{
    Body: {
      target?: 'new_session_from_preview' | 'current_session';
      previewId?: string;
      sessionId?: string;
      skill?: string;
      input?: Record<string, unknown>;
      client_id?: string;
    };
  }>('/commit', async (request, reply) => {
    await request.requireAuth();

    const target = request.body?.target;
    if (target !== 'new_session_from_preview' && target !== 'current_session') {
      return reply.code(400).send({ error: '非法 target' });
    }

    const result = await commitDirectPaipanForOwnedUser(
      request.user.userId,
      {
        target,
        previewId: request.body?.previewId,
        sessionId: request.body?.sessionId,
        skill: request.body?.skill,
        input: request.body?.input,
      },
      request.body?.client_id?.trim() || undefined,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });
}
