import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  claimDailySignInReward,
  getBillingDailyUsage,
  getBillingOverview,
  getBillingTransactions,
  getBillingUsage,
  getDailySignInStatus,
  getPublicStatusOverview,
  redeemCurrentUserGiftCode,
  resetBillingScope,
  subscribeCurrentUserMembership,
} from '../../modules/billing/billing-service.js';
import {
  createRechargeOrderForUser,
  getRechargeStatsForUser,
  handleRechargeNotification,
  listRechargeOrdersForUser,
  syncRechargeOrderForUser,
} from '../../modules/billing/recharge-service.js';
import { ACTIVE_MEMBERSHIP_PLAN_KEYS } from '../../shared/membership-plans.js';
import { resolvePaymentCallbackUrls } from './payment-callback-urls.js';

const MembershipPlanKeySchema = z.enum(ACTIVE_MEMBERSHIP_PLAN_KEYS);

const MembershipSubscribeSchema = z
  .object({
    plan_key: MembershipPlanKeySchema.optional(),
  })
  .optional();

const GiftCodeRedeemSchema = z.object({
  code: z.string().trim().min(1, '礼品码不能为空').max(80, '礼品码过长'),
});

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/billing — 积分余额与 Token 计费概览
  app.get('/', async (request, reply) => {
    await request.requireAuth();
    const result = await getBillingOverview(request.user.userId);
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // GET /api/billing/usage — usage stats (tokens, messages)
  app.get('/usage', async (request, reply) => {
    await request.requireAuth();
    const result = await getBillingUsage(request.user.userId);
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // GET /api/billing/usage/daily — daily token usage rows
  app.get('/usage/daily', async (request, reply) => {
    await request.requireAuth();
    const result = await getBillingDailyUsage(request.user.userId);
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // GET /api/billing/status — 全站状态页统计
  app.get('/status', async (_request, reply) => {
    const result = await getPublicStatusOverview();
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // GET /api/billing/transactions — recent wallet transactions
  app.get('/transactions', async (request, reply) => {
    await request.requireAuth();
    const result = await getBillingTransactions(request.user.userId, 20);
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // GET /api/billing/daily-sign-in — 当前用户每日签到状态
  app.get('/daily-sign-in', async (request, reply) => {
    await request.requireAuth();
    const result = await getDailySignInStatus(request.user.userId);
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // POST /api/billing/daily-sign-in — 领取每日签到积分奖励
  app.post('/daily-sign-in', async (request, reply) => {
    await request.requireAuth();
    const result = await claimDailySignInReward(request.user.userId);
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // POST /api/billing/gifts/redeem — 兑换积分礼品码
  app.post('/gifts/redeem', async (request, reply) => {
    await request.requireAuth();
    const parsed = GiftCodeRedeemSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '礼品码参数无效' });
    }
    const result = await redeemCurrentUserGiftCode(
      request.user.userId,
      parsed.data.code,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // POST /api/billing/membership/subscribe — 使用积分余额开通或续费会员套餐
  app.post('/membership/subscribe', async (request, reply) => {
    await request.requireAuth();
    const parsed = MembershipSubscribeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '会员套餐参数无效' });
    }
    const result = await subscribeCurrentUserMembership(
      request.user.userId,
      parsed.data?.plan_key,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // GET /api/billing/recharge/orders — 最近充值单
  app.get('/recharge/orders', async (request, reply) => {
    await request.requireAuth();
    const result = await listRechargeOrdersForUser(request.user.userId);
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // GET /api/billing/recharge/stats — 当前用户充值统计
  app.get('/recharge/stats', async (request, reply) => {
    await request.requireAuth();
    const result = await getRechargeStatsForUser(request.user.userId);
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // POST /api/billing/recharge/orders — 创建易支付充值单
  app.post('/recharge/orders', async (request, reply) => {
    await request.requireAuth();
    const body = (request.body || {}) as {
      amount_coins?: unknown;
      pay_type?: unknown;
    };
    const result = await createRechargeOrderForUser({
      userId: request.user.userId,
      amountCoins: body.amount_coins,
      payType: body.pay_type,
      clientIp: request.ip,
      callbackUrls: resolvePaymentCallbackUrls(request),
    });
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // POST /api/billing/recharge/orders/:tradeId/sync — 用户支付后主动查单补偿
  app.post<{ Params: { tradeId: string } }>(
    '/recharge/orders/:tradeId/sync',
    async (request, reply) => {
      await request.requireAuth();
      const result = await syncRechargeOrderForUser({
        userId: request.user.userId,
        tradeId: request.params.tradeId,
      });
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );

  // GET /api/billing/recharge/notify — 易支付异步通知入口（免登录）
  app.get('/recharge/notify', async (request, reply) => {
    const result = await handleRechargeNotification(request.query);
    if (!result.ok) {
      return reply
        .code(result.statusCode)
        .type('text/plain; charset=utf-8')
        .send('fail');
    }
    return reply.type('text/plain; charset=utf-8').send('success');
  });

  // POST /api/billing/recharge/notify — 兼容表单 POST 通知
  app.post('/recharge/notify', async (request, reply) => {
    const result = await handleRechargeNotification(request.body);
    if (!result.ok) {
      return reply
        .code(result.statusCode)
        .type('text/plain; charset=utf-8')
        .send('fail');
    }
    return reply.type('text/plain; charset=utf-8').send('success');
  });

  // POST /api/billing/reset — soft-reset user data by scope
  // 审查要求：数据不物理删除，仅标记 deleted_at；soul 文件归档后重建
  // scope: 'all' | 'messages' | 'memories'（默认 'all'）
  app.post('/reset', async (request, reply) => {
    await request.requireAuth();

    const { scope = 'all' } = (request.body as { scope?: string }) || {};
    const validScopes = ['all', 'messages', 'memories'];
    if (!validScopes.includes(scope)) {
      return reply
        .code(400)
        .send({ error: `无效的 scope，可选值：${validScopes.join(', ')}` });
    }

    const result = await resetBillingScope(
      request.user.userId,
      scope as 'all' | 'messages' | 'memories',
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }

    return result.data;
  });
}
