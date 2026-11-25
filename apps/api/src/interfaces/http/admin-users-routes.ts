import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  adjustUserPurchasedBalance,
  cancelAdminUserMembership,
  deleteUser,
  getBalanceGrantsByUserId,
  getUserById,
  getWalletTransactionsByUserId,
  grantBonusBalance,
  createAdminUser,
  listAdminUsersWithStats,
  resetAdminUserPassword,
  setAdminUserMembership,
  getAdminUserDetail,
} from '#modules/admin/admin-service';
import { MEMBERSHIP_PLAN_KEY } from '@fateclaw/contracts/membership';
import {
  calculateAvailableSpendableCoins,
  roundCoinsToCents,
} from '#shared/balance-coins';

function hasAtMostTwoDecimalPlaces(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-8;
}

// 金额绝对值上限：避免超大值导致 JS number 精度失真（>2^53）与荒谬调账。
const MAX_SOFT_CURRENCY_AMOUNT = 1_000_000;

const SoftCurrencyNumberSchema = z
  .number()
  .refine(Number.isFinite, '金额格式不正确')
  .refine(hasAtMostTwoDecimalPlaces, '金额最多支持 2 位小数')
  .refine(
    (value) => Math.abs(value) <= MAX_SOFT_CURRENCY_AMOUNT,
    '金额超出允许范围',
  )
  .transform(roundCoinsToCents);

const GrantBonusBalanceSchema = z.object({
  amount_coins: SoftCurrencyNumberSchema.refine(
    (value) => value > 0,
    '赠送积分必须为正数',
  ),
  source: z
    .enum(['new_user_gift', 'sign_in', 'admin_grant', 'promotion'])
    .default('admin_grant'),
  note: z.string().max(200).optional(),
  expires_at: z.string().datetime({ offset: true }).nullable().optional(),
});

const AdjustPurchasedBalanceSchema = z.object({
  amount_coins: SoftCurrencyNumberSchema.refine(
    (value) => value !== 0,
    '调整余额不能为 0',
  ),
  note: z.string().max(200).optional(),
});

const AdminCreateUserSchema = z.object({
  phone: z.string().trim().min(1, '手机号不能为空').max(32),
  password: z.string().min(8, '密码至少 8 位').max(128),
  role: z.enum(['consumer', 'creator', 'both', 'admin']).default('consumer'),
  phone_verified: z.boolean().default(true),
});

// 默认执行方案 A：user_manager 只能创建最低权限 consumer 用户。
const USER_MANAGER_CREATABLE_USER_ROLES = new Set(['consumer']);

const AdminResetUserPasswordSchema = z.object({
  password: z.string().min(8, '密码至少 8 位').max(128),
});

const MembershipPlanKeySchema = z.literal(MEMBERSHIP_PLAN_KEY);

const AdminSetUserMembershipSchema = z
  .object({
    plan_key: MembershipPlanKeySchema,
    current_period_end: z.string().datetime({ offset: true }),
  })
  .superRefine((value, ctx) => {
    const end = new Date(value.current_period_end);
    if (!Number.isFinite(end.getTime())) {
      ctx.addIssue({
        code: 'custom',
        path: ['current_period_end'],
        message: '会员有效期格式不正确',
      });
      return;
    }
    if (end.getTime() <= Date.now()) {
      ctx.addIssue({
        code: 'custom',
        path: ['current_period_end'],
        message: '会员有效期必须晚于当前时间',
      });
    }
  });

const AdminUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().max(120).optional(),
});

export async function adminUsersRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/admin/users — 分页获取用户（附带用量和账号数）
  app.get('/users', async (request) => {
    const query = AdminUsersQuerySchema.parse(request.query);
    return listAdminUsersWithStats({
      page: query.page,
      pageSize: query.page_size,
      query: query.q,
    });
  });

  // POST /api/admin/users — 管理员直接创建用户，不走短信验证码
  app.post('/users', async (request, reply) => {
    const body = AdminCreateUserSchema.parse(request.body);
    const principal = request.adminPrincipal;
    if (
      principal?.role !== 'owner' &&
      !USER_MANAGER_CREATABLE_USER_ROLES.has(body.role)
    ) {
      return reply
        .code(403)
        .send({ error: `user_manager 无权创建 ${body.role} 角色用户` });
    }
    try {
      const result = await createAdminUser({
        phone: body.phone,
        password: body.password,
        role: body.role,
        phoneVerified: body.phone_verified,
      });
      return reply.code(201).send({ success: true, id: result.id });
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : '创建用户失败',
      });
    }
  });

  // GET /api/admin/users/:id — 获取用户详情（含账号和用量）
  app.get('/users/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const detail = await getAdminUserDetail(id);
    if (!detail) {
      return reply.code(404).send({ error: '用户不存在' });
    }
    return detail;
  });

  // POST /api/admin/users/:id/password — 管理员重置用户密码并撤销旧登录态
  app.post('/users/:id/password', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = AdminResetUserPasswordSchema.parse(request.body);
    try {
      return await resetAdminUserPassword({
        userId: id,
        password: body.password,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '重置密码失败';
      return reply
        .code(message === '用户不存在' ? 404 : 400)
        .send({ error: message });
    }
  });

  // POST /api/admin/users/:id/membership — 管理员设置用户会员套餐与有效期
  app.post('/users/:id/membership', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = AdminSetUserMembershipSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '会员参数无效' });
    }
    const body = parsed.data;
    try {
      return await setAdminUserMembership({
        userId: id,
        planKey: body.plan_key,
        currentPeriodEnd: body.current_period_end,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '设置会员失败';
      return reply
        .code(message === '用户不存在' ? 404 : 400)
        .send({ error: message });
    }
  });

  // DELETE /api/admin/users/:id/membership — 管理员停用用户全部有效会员周期
  app.delete('/users/:id/membership', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await cancelAdminUserMembership(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : '停用会员失败';
      return reply
        .code(message === '用户不存在' ? 404 : 400)
        .send({ error: message });
    }
  });

  // GET /api/admin/users/:id/transactions — 最近余额流水
  app.get('/users/:id/transactions', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = await getUserById(id);
    if (!user) {
      return reply.code(404).send({ error: '用户不存在' });
    }
    return getWalletTransactionsByUserId(id, 50);
  });

  // POST /api/admin/users/:id/balance/grant — 管理员发放赠送积分（带过期时间）
  app.post('/users/:id/balance/grant', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = GrantBonusBalanceSchema.parse(request.body);
    const user = await getUserById(id);
    if (!user) {
      return reply.code(404).send({ error: '用户不存在' });
    }
    const { user: updated, grantId } = await grantBonusBalance({
      userId: id,
      source: body.source,
      amountCoins: body.amount_coins,
      expiresAt: body.expires_at ?? null,
      note: body.note ?? null,
      grantedBy: request.user?.userId ?? 'admin',
    });
    return {
      success: true,
      grant_id: grantId,
      bonus_coins: updated.bonus_coins,
      purchased_coins: updated.purchased_coins,
      reserved_coins: updated.reserved_coins,
      available_coins: calculateAvailableSpendableCoins(updated),
    };
  });

  // POST /api/admin/users/:id/balance/adjust — 管理员调整用户充值积分（正数=补充，负数=扣减）
  app.post('/users/:id/balance/adjust', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = AdjustPurchasedBalanceSchema.parse(request.body);
    const user = await getUserById(id);
    if (!user) {
      return reply.code(404).send({ error: '用户不存在' });
    }
    const updated = await adjustUserPurchasedBalance(
      id,
      body.amount_coins,
      body.note,
    );
    return {
      success: true,
      purchased_coins: updated.purchased_coins,
      bonus_coins: updated.bonus_coins,
      reserved_coins: updated.reserved_coins,
      available_coins: calculateAvailableSpendableCoins(updated),
    };
  });

  // GET /api/admin/users/:id/balance/grants — 查看用户赠送积分批次
  app.get('/users/:id/balance/grants', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as {
      include_exhausted?: string;
      limit?: string;
    };
    const user = await getUserById(id);
    if (!user) {
      return reply.code(404).send({ error: '用户不存在' });
    }
    return getBalanceGrantsByUserId(id, {
      includeExhausted: query.include_exhausted === 'true',
      limit: query.limit ? Number(query.limit) : undefined,
    });
  });

  // DELETE /api/admin/users/:id — 删除用户及其所有数据
  app.delete('/users/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = await getUserById(id);
    if (!user) {
      return reply.code(404).send({ error: '用户不存在' });
    }
    await deleteUser(id);
    return { success: true };
  });
}
