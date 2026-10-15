import type { FastifyInstance } from 'fastify';
import { getPublicServiceStatus } from '../../modules/system/service-status.js';

export async function serviceStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (_request, reply) => {
    reply.header(
      'Cache-Control',
      'public, max-age=60, stale-while-revalidate=60',
    );
    return getPublicServiceStatus();
  });
}
