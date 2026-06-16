import { FastifyInstance, FastifyRequest } from 'fastify';

import {
  commitDirectPaipanForOwnedUser,
  listDirectPaipanCatalogForOwnedUser,
  previewDirectPaipanForOwnedUser,
} from '../../modules/chat/paipan-service.js';
import { reverseGanzhiForPaipan } from '../../modules/chat/ganzhi-reverse-service.js';
import { getUserById } from '../../infrastructure/db.js';

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
    };
  }>('/preview', async (request, reply) => {
    const skill = request.body?.skill?.trim();
    const input = request.body?.input;

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
    });
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  app.post<{
    Body: unknown;
  }>('/ganzhi-reverse', async (request, reply) => {
    const result = reverseGanzhiForPaipan(request.body);
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  app.post<{
    Body: {
      target?: 'new_session_from_preview' | 'current_session';
      previewId?: string;
      sessionId?: string;
      skill?: string;
      input?: Record<string, unknown>;
    };
  }>('/commit', async (request, reply) => {
    await request.requireAuth();

    const target = request.body?.target;
    if (target !== 'new_session_from_preview' && target !== 'current_session') {
      return reply.code(400).send({ error: '非法 target' });
    }

    const result = await commitDirectPaipanForOwnedUser(request.user.userId, {
      target,
      previewId: request.body?.previewId,
      sessionId: request.body?.sessionId,
      skill: request.body?.skill,
      input: request.body?.input,
    });
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });
}
