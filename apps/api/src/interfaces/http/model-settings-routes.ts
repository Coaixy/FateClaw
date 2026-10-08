import type { FastifyInstance } from 'fastify';

import { getUserModelSettingsOverview } from '../../modules/system/system-config.js';

export async function modelSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request) => {
    await request.requireAuth();
  });

  app.get('/', async () => getUserModelSettingsOverview());
}
