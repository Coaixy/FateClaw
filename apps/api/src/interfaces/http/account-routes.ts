import { FastifyInstance } from 'fastify';

import {
  bindAccountForUser,
  deleteOwnedAccountAndRuntime,
  getAccountBindingQrCodeStatus,
  getOwnedSoulContent,
  getSafeOwnedAccount,
  listSafeAccountsForUser,
  requestAccountBindingQrCode,
  updateOwnedSoulContent,
} from '../../modules/account/account-http-service.js';

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/account — list my accounts
  app.get('/', async (request) => {
    await request.requireAuth();
    return listSafeAccountsForUser(request.user.userId);
  });

  // GET /api/account/:id — get single account detail
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    await request.requireAuth();
    const account = await getSafeOwnedAccount(
      request.user.userId,
      request.params.id,
    );
    if (!account) {
      return reply.code(404).send({ error: '账号不存在' });
    }
    return account;
  });

  // GET /api/account/:id/soul — read soul content from DB
  app.get<{ Params: { id: string } }>('/:id/soul', async (request, reply) => {
    await request.requireAuth();
    const result = await getOwnedSoulContent(
      request.user.userId,
      request.params.id,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // PUT /api/account/:id/soul — update soul content in DB and sync file
  app.put<{ Params: { id: string }; Body: { content: string } }>(
    '/:id/soul',
    async (request, reply) => {
      await request.requireAuth();
      const { content } = request.body as { content: string };
      if (typeof content !== 'string') {
        return reply.code(400).send({ error: '缺少 content 字段' });
      }
      const result = await updateOwnedSoulContent(
        request.user.userId,
        request.params.id,
        content,
      );
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );

  // POST /api/account/:id/bind — bind existing account to current user
  app.post<{ Params: { id: string } }>('/:id/bind', async (request, reply) => {
    await request.requireAuth();
    const result = await bindAccountForUser(
      request.user.userId,
      request.params.id,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // DELETE /api/account/:id — unbind and delete account
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    await request.requireAuth();
    const result = await deleteOwnedAccountAndRuntime(
      request.user.userId,
      request.params.id,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // ─── WeChat QR code binding flow ─────────────────────────────────────

  // POST /api/account/qrcode — get a new QR code for binding
  app.post('/qrcode', async (request, reply) => {
    await request.requireAuth();
    const result = await requestAccountBindingQrCode(request.user.userId);
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // POST /api/account/qrcode/status — poll QR code status
  app.post<{ Body: { qrcode: string } }>(
    '/qrcode/status',
    async (request, reply) => {
      await request.requireAuth();
      const { qrcode } = request.body as { qrcode: string };
      if (!qrcode) {
        return reply.code(400).send({ error: '缺少 qrcode 参数' });
      }

      const result = await getAccountBindingQrCodeStatus(
        request.user.userId,
        qrcode,
      );
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );
}
