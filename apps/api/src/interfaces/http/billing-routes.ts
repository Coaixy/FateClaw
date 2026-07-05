import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  getBillingDailyUsage,
  getBillingOverview,
  getBillingTransactions,
  getBillingUsage,
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
import { getRedis } from '../../infrastructure/redis.js';

// 易支付 notify 是免登录入口、验签是唯一闸门。加一道**宽松**的 per-IP 限流，
// 防止用无效签名洪泛放大验签（RSA）和单行 upsert 写的 CPU/DB 负载。
// 限额远高于正当 epay（每单仅几次通知），正常回调绝不触顶；
// Redis 异常时 fail-open（放行），绝不因限流误丢正当支付通知。
const RECHARGE_NOTIFY_RATE_LIMIT_PER_MIN = 120;

async function allowRechargeNotify(ip: string): Promise<boolean> {
  try {
    const key = `ratelimit:recharge-notify:${ip || 'unknown'}`;
    const count = await getRedis().incr(key);
    if (count === 1) {
      await getRedis().expire(key, 60);
    }
    return count <= RECHARGE_NOTIFY_RATE_LIMIT_PER_MIN;
  } catch {
    return true; // fail-open：限流设施异常不阻断正当通知
  }
}

const MembershipPlanKeySchema = z.enum(ACTIVE_MEMBERSHIP_PLAN_KEYS);

const MembershipSubscribeSchema = z
  .object({
    plan_key: MembershipPlanKeySchema.optional(),
  })
  .optional();

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

  // GET /api/billing/transactions — recent wallet transactions
  app.get('/transactions', async (request, reply) => {
    await request.requireAuth();
    const result = await getBillingTransactions(request.user.userId, 20);
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
    if (!(await allowRechargeNotify(request.ip))) {
      return reply.code(429).type('text/plain; charset=utf-8').send('fail');
    }
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
    if (!(await allowRechargeNotify(request.ip))) {
      return reply.code(429).type('text/plain; charset=utf-8').send('fail');
    }
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
