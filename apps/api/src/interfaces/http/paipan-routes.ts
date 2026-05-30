import { FastifyInstance } from 'fastify';

import {
  commitDirectPaipanForOwnedUser,
  listDirectPaipanCatalogForOwnedUser,
  previewDirectPaipanForOwnedUser,
} from '../../modules/chat/paipan-service.js';

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

    const result = await previewDirectPaipanForOwnedUser({
      skill,
      input,
    });
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
