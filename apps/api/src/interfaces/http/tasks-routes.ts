import { FastifyInstance } from 'fastify';

import {
  deleteOwnedTask,
  listTasksForOwnedAccount,
} from '../../modules/tasks/task-service.js';

export async function tasksRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/tasks/:accountId — list tasks for an account
  app.get<{ Params: { accountId: string } }>(
    '/:accountId',
    async (request, reply) => {
      await request.requireAuth();
      const result = await listTasksForOwnedAccount(
        request.user.userId,
        request.params.accountId,
      );
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );

  // DELETE /api/tasks/:taskId — delete a task
  app.delete<{ Params: { taskId: string } }>(
    '/:taskId',
    async (request, reply) => {
      await request.requireAuth();
      const result = await deleteOwnedTask(
        request.user.userId,
        request.params.taskId,
      );
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );
}
