import type { FastifyInstance } from 'fastify';
import type { SimpleWorkflowStartRequestDto } from '@fateclaw/contracts/chat';

import { startSimpleWorkflowForOwnedUser } from '../../modules/chat/simple-workflow-service.js';

/**
 * 注册简易模式 workflow HTTP 路由。
 *
 * @param app Fastify 实例。
 * @returns 路由注册完成后返回。
 */
export async function simpleWorkflowsRoutes(
  app: FastifyInstance,
): Promise<void> {
  // POST /api/simple-workflows/start — 按占卜/命理入口启动简易模式会话
  app.post<{
    Body: SimpleWorkflowStartRequestDto;
  }>('/start', async (request, reply) => {
    await request.requireAuth();

    const body = request.body;
    if (!body || (body.kind !== 'divination' && body.kind !== 'natal')) {
      return reply.code(400).send({ error: '请选择占卜问事或命理分析' });
    }

    const result = await startSimpleWorkflowForOwnedUser(
      request.user.userId,
      body,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });
}
