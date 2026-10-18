import { FastifyInstance } from 'fastify';

import { listMessagesForOwnedAccount } from '#modules/chat/web-chat-service';

export async function messagesRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/messages/:accountId?limit=50
  app.get<{
    Params: { accountId: string };
    Querystring: { limit?: string; before?: string };
  }>('/:accountId', async (request, reply) => {
    await request.requireAuth();

    const limit = Math.min(
      parseInt(request.query.limit || '50', 10) || 50,
      200,
    );
    const result = await listMessagesForOwnedAccount(
      request.user.userId,
      request.params.accountId,
      limit,
      request.query.before || undefined,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });
}
