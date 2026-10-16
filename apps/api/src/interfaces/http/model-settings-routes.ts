import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { getUserModelSettingsOverview } from '../../modules/system/system-config.js';
import { saveModelPoolPreference } from '../../infrastructure/repositories/benefit-repository.js';
import { getChatSession } from '../../infrastructure/repositories/chat-repository.js';
import {
  claimOrRefreshSessionProcessingLock,
  releaseSessionProcessingLock,
} from '../../runtime/ipc-payloads.js';

export async function modelSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request) => {
    await request.requireAuth();
  });

  app.get('/', async (request) =>
    getUserModelSettingsOverview(request.user.userId),
  );
  app.put('/preference', async (request, reply) => {
    const parsed = z
      .strictObject({
        pool_key: z.enum(['official', 'benefit']),
        session_id: z.string().min(1).max(200).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: '模型选择参数不正确' });
    const sessionId = parsed.data.session_id;
    if (sessionId) {
      const session = await getChatSession(sessionId);
      if (
        !session ||
        session.user_id !== request.user.userId ||
        session.deleted_at
      )
        return reply.code(404).send({ error: '会话不存在或无权访问' });
    }
    const owner = `model-switch:${randomUUID()}`;
    if (
      sessionId &&
      !(await claimOrRefreshSessionProcessingLock(sessionId, owner, 30))
    )
      return reply.code(409).send({ error: '请等待当前回复结束后再切换模型' });
    try {
      await saveModelPoolPreference(
        request.user.userId,
        parsed.data.pool_key,
        sessionId,
      );
      return getUserModelSettingsOverview(request.user.userId);
    } finally {
      if (sessionId) await releaseSessionProcessingLock(sessionId, owner);
    }
  });
}
