import { FastifyInstance } from 'fastify';

import {
  getMyReferralSummary,
  previewInviteCode,
  redeemInviteCodeForUser,
} from '../../modules/referrals/referrals-service.js';

function normalizeCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * 注册用户侧邀请 API 路由。
 */
export async function referralsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/referrals/me — 当前用户邀请概览
  app.get('/me', async (request, reply) => {
    await request.requireAuth();
    const result = await getMyReferralSummary(request.user.userId);
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // GET /api/referrals/invites/:code/preview — 公开预览邀请码
  app.get('/invites/:code/preview', async (request, reply) => {
    const code = normalizeCode((request.params as { code?: string }).code);
    if (!code) return reply.code(400).send({ error: '邀请码不能为空' });
    const result = await previewInviteCode(code);
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // POST /api/referrals/invites/:code/redeem — 登录后绑定邀请码
  app.post('/invites/:code/redeem', async (request, reply) => {
    await request.requireAuth();
    const code = normalizeCode((request.params as { code?: string }).code);
    if (!code) return reply.code(400).send({ error: '邀请码不能为空' });
    const result = await redeemInviteCodeForUser(request.user.userId, code);
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });
}
