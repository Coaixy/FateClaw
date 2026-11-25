import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BILLING_RESERVATION_STALE_MS } from '#infrastructure/config';
import {
  getAdminRechargePaymentConfig,
  listBillingRequestReservations,
  listBillingRequestReservationsPageForAdmin,
  listRechargeOrdersForAdmin,
  listWalletTransactionsForAdmin,
  reconcileStaleBillingReservations,
  updateAdminRechargePaymentConfig,
  getMembershipPlanConfigsForAdmin,
  updateMembershipPlanConfig,
} from '#modules/admin/admin-service';
import { toMembershipPlanDto } from '#contracts-adapter/billing-contract';
import { roundCoinsToCents } from '#shared/balance-coins';
import { resolvePaymentCallbackUrls } from './payment-callback-urls.js';

/**
 * 管理员更新会员套餐配置的请求体；所有字段可选，至少提供一个才生效。
 */
const UpdateMembershipConfigSchema = z
  .object({
    monthly_price_coins: z.number().min(0).optional(),
    display_price_coins: z.number().min(0).optional(),
    name: z.string().trim().min(1).max(80).optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (value) => Object.values(value).some((v) => v !== undefined),
    '至少需要提供一个更新字段',
  );

const AdminRechargeOrdersQuerySchema = z.object({
  user_id: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['pending', 'paid', 'failed']).optional(),
  pay_type: z.enum(['alipay', 'wechat']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const AdminWalletTransactionsQuerySchema = z.object({
  user_id: z.string().trim().min(1).max(120).optional(),
  kind: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const AdminBillingReservationsQuerySchema = z.object({
  user_id: z.string().trim().min(1).max(120).optional(),
  hold_state: z.enum(['none', 'held', 'released']).optional(),
  charge_state: z.enum(['pending', 'charged']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  include_total: z.enum(['true', 'false']).optional(),
});

const RechargeMoneySchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, '金额最多支持 2 位小数')
  .refine((value) => Number(value) > 0, '金额必须大于 0')
  .transform((value) => roundCoinsToCents(Number(value)).toFixed(2));

const RechargePaymentConfigSchema = z
  .object({
    enabled: z.boolean(),
    min_coins: RechargeMoneySchema,
    max_coins: RechargeMoneySchema,
    epay_url_prefix: z.string().trim().max(500),
    epay_platform_id: z.number().int().positive().nullable(),
    epay_merchant_private_key: z.string().max(8000),
    epay_platform_public_key: z.string().max(8000),
    epay_merchant_key: z.string().trim().max(1000),
    notify_url: z.string().trim().max(500).optional(),
    return_url: z.string().trim().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (Number(value.max_coins) < Number(value.min_coins)) {
      ctx.addIssue({
        code: 'custom',
        path: ['max_coins'],
        message: '最高充值金额不能小于最低充值金额',
      });
    }
    if (!value.enabled) return;
    const requiredFields: Array<[keyof typeof value, string]> = [
      ['epay_url_prefix', '易支付网关地址不能为空'],
      ['epay_platform_id', '易支付商户 ID 不能为空'],
      ['epay_merchant_private_key', '商户私钥不能为空'],
      ['epay_platform_public_key', '平台公钥不能为空'],
      ['epay_merchant_key', '商户查询密钥不能为空'],
    ];
    for (const [key, message] of requiredFields) {
      if (!value[key]) {
        ctx.addIssue({ code: 'custom', path: [key], message });
      }
    }
  });

export async function adminBillingRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/admin/membership-config — 读取全部会员套餐配置（含已停用，后台改价用）
  app.get('/membership-config', async () => {
    const summaries = await getMembershipPlanConfigsForAdmin();
    // 转为对外稳定的 snake_case DTO，与用户侧 /api/billing 的套餐字段一致。
    return { plans: summaries.map(toMembershipPlanDto) };
  });

  // PATCH /api/admin/membership-config/:planKey — 更新套餐价格/展示价/名称/启用状态
  app.patch('/membership-config/:planKey', async (request, reply) => {
    const { planKey } = request.params as { planKey: string };
    const parsed = UpdateMembershipConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    const result = await updateMembershipPlanConfig(planKey, {
      monthlyPriceCoins: parsed.data.monthly_price_coins,
      displayPriceCoins: parsed.data.display_price_coins,
      name: parsed.data.name,
      enabled: parsed.data.enabled,
    });
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return toMembershipPlanDto(result.data);
  });

  // GET /api/admin/recharge-config — 读取数据库中的充值配置
  app.get('/recharge-config', async (request) => {
    return getAdminRechargePaymentConfig(resolvePaymentCallbackUrls(request));
  });

  // PUT /api/admin/recharge-config — 更新易支付充值配置
  app.put('/recharge-config', async (request, reply) => {
    const parsed = RechargePaymentConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    return updateAdminRechargePaymentConfig(
      parsed.data,
      resolvePaymentCallbackUrls(request),
    );
  });

  // GET /api/admin/billing/recharge-orders — 查询全局充值订单
  app.get('/billing/recharge-orders', async (request, reply) => {
    const parsed = AdminRechargeOrdersQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    return listRechargeOrdersForAdmin({
      userId: parsed.data.user_id,
      status: parsed.data.status,
      payType: parsed.data.pay_type,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
  });

  // GET /api/admin/billing/wallet-transactions — 查询全局余额流水
  app.get('/billing/wallet-transactions', async (request, reply) => {
    const parsed = AdminWalletTransactionsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    return listWalletTransactionsForAdmin({
      userId: parsed.data.user_id,
      kind: parsed.data.kind,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
  });

  // GET /api/admin/billing/reservations — 查询请求级预留记录
  app.get('/billing/reservations', async (request, reply) => {
    const parsed = AdminBillingReservationsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    const opts = {
      userId: parsed.data.user_id,
      holdState: parsed.data.hold_state,
      chargeState: parsed.data.charge_state,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    };
    if (parsed.data.include_total === 'true') {
      return listBillingRequestReservationsPageForAdmin(opts);
    }
    return listBillingRequestReservations(opts);
  });

  // POST /api/admin/billing/reconcile — 手动触发陈旧预留修复
  app.post('/billing/reconcile', async (request) => {
    const body = (request.body as { stale_ms?: number; limit?: number }) || {};
    const staleMs = Math.max(
      60_000,
      body.stale_ms ?? BILLING_RESERVATION_STALE_MS,
    );
    const staleBeforeIso = new Date(Date.now() - staleMs).toISOString();
    return reconcileStaleBillingReservations(staleBeforeIso, body.limit ?? 100);
  });
}
