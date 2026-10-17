import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  assertRegistrationInviteValid,
  createRegistrationInvite,
  getRegistrationInvitePolicy,
  getRegistrationInviteSummary,
  listCompletedRechargeRefunds,
  listRegistrationInvites,
  recordCompletedRechargeRefund,
  revokeRegistrationInvite,
  saveRegistrationInvitePolicy,
  updateRegistrationInviteAccount,
} from '../../infrastructure/repositories/registration-invites-repository.js';
import { fixedWindowRateLimit } from './rate-limit.js';

export const RegistrationInviteCodeSchema = z
  .string()
  .trim()
  .min(1, '请输入邀请码')
  .max(64, '邀请码格式不正确');
const requestSchema = z.object({
  request_key: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase()),
});
const idSchema = z.object({ id: z.string().uuid() });
const userSchema = z.object({ userId: z.string().trim().min(1).max(100) });
const userFilterSchema = z.object({
  user_id: z.string().trim().min(1).max(100).optional(),
});
const moneySchema = z
  .number()
  .finite()
  .min(0.01, '金额至少为 0.01 元')
  .max(1_000_000)
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8,
    '金额最多支持两位小数',
  );
const revisionSchema = z.number().int().min(1).max(2147483646);
const tiersSchema = z
  .array(
    z.object({
      threshold_yuan: moneySchema,
      total_slots: z.number().int().min(1).max(1000),
    }),
  )
  .min(1)
  .max(10)
  .superRefine((tiers, context) => {
    for (let index = 1; index < tiers.length; index += 1) {
      if (
        Math.round(tiers[index].threshold_yuan * 100) <=
        Math.round(tiers[index - 1].threshold_yuan * 100)
      ) {
        context.addIssue({
          code: 'custom',
          path: [index, 'threshold_yuan'],
          message: '充值门槛必须逐档递增',
        });
      }
      if (tiers[index].total_slots <= tiers[index - 1].total_slots) {
        context.addIssue({
          code: 'custom',
          path: [index, 'total_slots'],
          message: '累计总名额必须逐档递增',
        });
      }
    }
  });

export async function allowRegistrationAttempt(
  ip: string,
  reply: FastifyReply,
): Promise<boolean> {
  const result = await fixedWindowRateLimit(`registration:${ip}`, 20, 600);
  if (result.allowed) return true;
  reply
    .header('Retry-After', result.retryAfterSec)
    .code(result.unavailable ? 503 : 429)
    .send({
      error: result.unavailable
        ? '注册服务暂时不可用，请稍后重试'
        : '注册请求过于频繁，请稍后再试',
    });
  return false;
}

export async function registrationInviteRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  app.post('/preview', async (request, reply) => {
    if (!(await allowRegistrationAttempt(request.ip, reply))) return;
    const body = z
      .object({ inviteCode: RegistrationInviteCodeSchema })
      .parse(request.body);
    return assertRegistrationInviteValid(body.inviteCode);
  });
  app.get('/me', async (request) => {
    await request.requireAuth();
    return getRegistrationInviteSummary(request.user.userId);
  });
  app.post('/', async (request, reply) => {
    await request.requireAuth();
    const body = requestSchema.parse(request.body);
    return reply
      .code(201)
      .send(
        await createRegistrationInvite(request.user.userId, body.request_key),
      );
  });
  app.post('/:id/revoke', async (request) => {
    await request.requireAuth();
    const { id } = idSchema.parse(request.params);
    await revokeRegistrationInvite(id, request.user.userId);
    return getRegistrationInviteSummary(request.user.userId);
  });
}

function requireOwner(request: FastifyRequest): void {
  if (!request.adminPrincipal?.scopes.includes('admin:*')) {
    throw Object.assign(new Error('无权访问该管理功能'), { statusCode: 403 });
  }
}

// Inherit the canonical administrator authentication hook and check the owner scope as well.
export async function adminRegistrationInviteRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('preHandler', async (request, reply) => {
    requireOwner(request);
    reply.header('Cache-Control', 'no-store');
  });
  app.get('/policy', async () => getRegistrationInvitePolicy());
  app.put('/policy', async (request) => {
    const body = z
      .object({
        tiers: tiersSchema,
        expires_in_days: z.number().int().min(1).max(90),
        expected_revision: revisionSchema,
      })
      .parse(request.body);
    return saveRegistrationInvitePolicy(body);
  });
  app.get('/users/:userId', async (request) => {
    const { userId } = userSchema.parse(request.params);
    return getRegistrationInviteSummary(userId);
  });
  app.patch('/users/:userId', async (request) => {
    const { userId } = userSchema.parse(request.params);
    const body = z
      .object({
        total_slots: z.number().int().min(0).max(1000),
        suspended: z.boolean(),
        expected_revision: revisionSchema,
      })
      .parse(request.body);
    return updateRegistrationInviteAccount(userId, body);
  });
  app.get('/', async (request) => {
    const { user_id } = userFilterSchema.parse(request.query);
    return { items: await listRegistrationInvites(user_id) };
  });
  app.post('/', async (request, reply) => {
    const { request_key } = requestSchema.parse(request.body);
    return reply
      .code(201)
      .send(await createRegistrationInvite(null, request_key));
  });
  app.post('/:id/revoke', async (request) => {
    const { id } = idSchema.parse(request.params);
    await revokeRegistrationInvite(id);
    return { success: true };
  });
  app.get('/refunds', async (request) => {
    const { user_id } = userFilterSchema.parse(request.query);
    return { items: await listCompletedRechargeRefunds(user_id) };
  });
  app.post('/refunds', async (request) => {
    const body = z
      .object({
        trade_id: z.string().trim().min(1).max(100),
        amount_yuan: moneySchema,
        reference: z.string().trim().min(1).max(120),
        reason: z.string().trim().min(1).max(500),
      })
      .parse(request.body);
    return recordCompletedRechargeRefund(body);
  });
}
