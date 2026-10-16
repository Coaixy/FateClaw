import crypto from 'node:crypto';

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adminIssueRoutes } from './issues-routes.js';

import {
  BILLING_RESERVATION_STALE_MS,
  MANAGER_KEY,
  USER_MANAGER_KEY,
} from '../../infrastructure/config.js';
import {
  adjustUserPurchasedBalance,
  cancelAdminUserMembership,
  deleteConversationLogsForAdminUser,
  deleteUser,
  getAdminGlobalStats,
  getAdminRechargePaymentConfig,
  getChatSessionsForAdmin,
  getConversationLogById,
  getConversationLogByRequestId,
  getConversationLogSummaries,
  getCustomSkillForAdmin,
  getCustomSkillsForAdmin,
  getMessagesForAdmin,
  getBalanceGrantsByUserId,
  getSystemConfigOverview,
  saveOfficialModelSettings,
  getUserById,
  getUserCustomSkillById,
  getWalletTransactionsByUserId,
  grantBonusBalance,
  hasOfficialSkill,
  createAdminUser,
  cleanupPiSessionFilesForAdmin,
  scanPiSessionOrphanFilesForAdmin,
  listAdminGlobalSkills,
  listSkillCommentsForAdmin,
  listAdminUsersWithStats,
  listBillingRequestReservations,
  listBillingRequestReservationsPageForAdmin,
  listRechargeOrdersForAdmin,
  listWalletTransactionsForAdmin,
  reconcileStaleBillingReservations,
  resetAdminUserPassword,
  setAdminUserMembership,
  setSkillGlobalEnabled,
  setSkillCommentPinnedForAdmin,
  setUserCustomSkillAdminState,
  reviewSkillCommentForAdmin,
  updateAdminRechargePaymentConfig,
  getAdminUserDetail,
  getAdminStatusOverview,
  getMembershipPlanConfigsForAdmin,
  updateMembershipPlanConfig,
  getAdminChatSessionDetail,
} from '../../modules/admin/admin-service.js';
import {
  toAdminSkillCommentDto,
  toAdminSkillCommentDtos,
} from '../../contracts-adapter/skills-contract.js';
import { toMembershipPlanDto } from '../../contracts-adapter/billing-contract.js';
import {
  rateLimitCheck,
  rateLimitRecordFail,
  rateLimitClear,
} from './rate-limit.js';
import {
  MAX_CONFIGURED_CONTEXT_WINDOW_TOKENS,
  MIN_CONFIGURED_CONTEXT_WINDOW_TOKENS,
} from '../../shared/model-context-window.js';
import { PI_THINKING_LEVELS } from '../../shared/types.js';
import { MEMBERSHIP_PLAN_KEY } from '@fateclaw/contracts/membership';
import {
  calculateAvailableSpendableCoins,
  roundCoinsToCents,
} from '../../shared/balance-coins.js';
import { resolvePaymentCallbackUrls } from './payment-callback-urls.js';
import { collectRuntimeStatus } from '../../runtime/runtime-status.js';

type AdminRole = 'owner' | 'user_manager';
type AdminScope = 'admin:*' | 'users:read' | 'users:create' | 'messages:read';
type AdminHomePath = '/admin/overview' | '/admin/users';

interface AdminPrincipal {
  role: AdminRole;
  scopes: AdminScope[];
  home_path: AdminHomePath;
}

const OWNER_ADMIN_PRINCIPAL: AdminPrincipal = {
  role: 'owner',
  scopes: ['admin:*'],
  home_path: '/admin/overview',
};

const USER_MANAGER_ADMIN_PRINCIPAL: AdminPrincipal = {
  role: 'user_manager',
  scopes: ['users:read', 'users:create', 'messages:read'],
  home_path: '/admin/users',
};

const USER_MANAGER_ALLOWED_ROUTES = new Map<string, AdminScope>([
  ['GET /users', 'users:read'],
  ['POST /users', 'users:create'],
  ['GET /users/:id', 'users:read'],
  ['GET /users/:id/transactions', 'users:read'],
  ['GET /users/:id/balance/grants', 'users:read'],
  ['GET /messages', 'messages:read'],
  ['GET /chat-sessions', 'messages:read'],
]);

function normalizeAdminRouteUrl(
  routeUrl: string | undefined,
): string | undefined {
  if (!routeUrl) return routeUrl;
  // Fastify 带 prefix 注册插件时会把前缀并入 routeOptions.url，权限表统一用插件内路径维护。
  if (routeUrl.startsWith('/api/admin')) {
    return routeUrl.slice('/api/admin'.length) || '/';
  }
  return routeUrl;
}

function cloneAdminPrincipal(principal: AdminPrincipal): AdminPrincipal {
  return {
    role: principal.role,
    scopes: [...principal.scopes],
    home_path: principal.home_path,
  };
}

function resolveAdminPrincipal(key: string | undefined): AdminPrincipal | null {
  if (key && MANAGER_KEY && key === MANAGER_KEY) {
    return cloneAdminPrincipal(OWNER_ADMIN_PRINCIPAL);
  }
  if (key && USER_MANAGER_KEY && key === USER_MANAGER_KEY) {
    return cloneAdminPrincipal(USER_MANAGER_ADMIN_PRINCIPAL);
  }
  return null;
}

function getRequiredAdminScope(
  method: string,
  routeUrl: string | undefined,
): AdminScope | null {
  const normalizedRouteUrl = normalizeAdminRouteUrl(routeUrl);
  if (normalizedRouteUrl === '/verify') return null;
  return (
    USER_MANAGER_ALLOWED_ROUTES.get(`${method} ${normalizedRouteUrl}`) ??
    'admin:*'
  );
}

function hasAdminScope(
  principal: AdminPrincipal,
  required: AdminScope,
): boolean {
  return (
    principal.scopes.includes('admin:*') || principal.scopes.includes(required)
  );
}

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

const PiSessionCleanupSchema = z.object({
  mode: z.enum(['soft_deleted', 'inactive']),
  inactive_days: z.number().int().min(1).max(3650).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
});

const PiSessionOrphanScanSchema = z.object({
  action: z.enum(['audit', 'delete']).default('audit'),
  limit: z.number().int().min(1).max(50_000).optional(),
  sample_limit: z.number().int().min(1).max(100).optional(),
});

const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  });

const AdminStatsQuerySchema = z
  .object({
    recharge_range: z
      .enum(['today', '7d', '30d', 'month', 'custom', 'all'])
      .optional(),
    recharge_start_date: DateOnlySchema.optional(),
    recharge_end_date: DateOnlySchema.optional(),
  })
  .superRefine((query, ctx) => {
    const hasCustomDate =
      Boolean(query.recharge_start_date) || Boolean(query.recharge_end_date);
    if (!hasCustomDate) return;

    if (!query.recharge_start_date) {
      ctx.addIssue({
        code: 'custom',
        path: ['recharge_start_date'],
        message: '开始日期不能为空',
      });
    }
    if (!query.recharge_end_date) {
      ctx.addIssue({
        code: 'custom',
        path: ['recharge_end_date'],
        message: '结束日期不能为空',
      });
    }
    if (
      query.recharge_start_date &&
      query.recharge_end_date &&
      query.recharge_start_date > query.recharge_end_date
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['recharge_end_date'],
        message: '结束日期不能早于开始日期',
      });
    }
  });

const AdminUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().max(120).optional(),
});

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

const OfficialModelAuthModeSchema = z
  .enum([
    'openai_api_key',
    'anthropic_api_key',
    'claude_code_oauth_token',
    'gemini_api_key',
  ])
  .optional();

const OfficialModelPoolNodeSchema = z
  .strictObject({
    id: z.string().trim().min(1).max(120).optional(),
    display_name: z.string().trim().min(1).max(120),
    pi_api: z.enum([
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
      'google-generative-ai',
    ]),
    base_url: z.string().trim().max(500).nullable(),
    model_name: z.string().trim().min(1).max(120),
    api_key: z.string().trim().max(2000).optional(),
    auth_mode: OfficialModelAuthModeSchema,
    enabled: z.boolean(),
    weight: z.number().int().min(1).max(1000),
    context_window_tokens: z
      .number()
      .int()
      .min(0)
      .max(MAX_CONFIGURED_CONTEXT_WINDOW_TOKENS)
      .refine(
        (value) => value === 0 || value >= MIN_CONFIGURED_CONTEXT_WINDOW_TOKENS,
        `上下文窗口需为 0，或不小于 ${MIN_CONFIGURED_CONTEXT_WINDOW_TOKENS}`,
      )
      .nullable(),
  })
  .superRefine((config, ctx) => {
    if (!config.auth_mode) return;
    const allowed =
      config.pi_api === 'anthropic-messages'
        ? ['anthropic_api_key', 'claude_code_oauth_token']
        : config.pi_api === 'google-generative-ai'
          ? ['gemini_api_key']
          : ['openai_api_key'];
    if (!allowed.includes(config.auth_mode)) {
      ctx.addIssue({
        code: 'custom',
        path: ['auth_mode'],
        message: '认证方式与接口协议不匹配',
      });
    }
  });

const OfficialModelSettingsSchema = z
  .strictObject({
    display_name: z.string().trim().min(1).max(120),
    thinking_level: z.enum(PI_THINKING_LEVELS),
    input_token_price_per_million_coins: z.number().int().min(0).max(1_000_000),
    output_token_price_per_million_coins: z
      .number()
      .int()
      .min(0)
      .max(1_000_000),
    nodes: z.array(OfficialModelPoolNodeSchema).min(1).max(20),
  })
  .superRefine((config, ctx) => {
    const ids = config.nodes.flatMap((node) => (node.id ? [node.id] : []));
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['nodes'],
        message: '模型节点不能重复',
      });
    }
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

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // 所有 admin 路由需要验证后台密钥，并对失败鉴权统一做指数退避限流。
  app.addHook('onRequest', async (request, reply) => {
    if (!MANAGER_KEY && !USER_MANAGER_KEY) {
      return reply.code(503).send({ error: '管理端未配置密钥' });
    }

    const ipHash = crypto
      .createHash('sha256')
      .update(request.ip)
      .digest('hex')
      .slice(0, 16);
    const rateKey = `admin:${ipHash}`;
    const check = await rateLimitCheck(rateKey);
    if (!check.allowed) {
      request.log.warn(
        { ipHash, retryAfterMs: check.retryAfterMs },
        'admin auth rate limited',
      );
      return reply
        .code(429)
        .header('Retry-After', Math.ceil((check.retryAfterMs ?? 1000) / 1000))
        .send({ error: '尝试过于频繁，请稍后再试' });
    }

    const rawKey = request.headers['x-admin-key'];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    const principal = resolveAdminPrincipal(key);
    if (!principal) {
      await rateLimitRecordFail(rateKey);
      return reply.code(401).send({ error: '管理密钥无效' });
    }

    request.adminPrincipal = principal;
    await rateLimitClear(rateKey);
  });

  app.addHook('preHandler', async (request, reply) => {
    const principal = request.adminPrincipal;
    if (!principal) {
      return reply.code(401).send({ error: '管理密钥无效' });
    }

    const required = getRequiredAdminScope(
      request.method,
      request.routeOptions.url,
    );
    if (required && !hasAdminScope(principal, required)) {
      return reply.code(403).send({ error: '无权访问该管理功能' });
    }
  });

  await app.register(adminIssueRoutes, { prefix: '/issues' });

  // POST /api/admin/verify — 验证密钥是否正确
  app.post('/verify', async (request) => {
    const principal = request.adminPrincipal ?? OWNER_ADMIN_PRINCIPAL;
    return {
      success: true,
      role: principal.role,
      scopes: principal.scopes,
      home_path: principal.home_path,
    };
  });

  // GET /api/admin/runtime-status — 运行时状态快照（本地子进程 / IPC 监听 /
  // 队列深度 / runtime 心跳 / 并发闸门），用于主动发现掉线与堆积。
  app.get('/runtime-status', async () => {
    return collectRuntimeStatus();
  });

  // GET /api/admin/stats — 全局统计数据，可按时间范围聚合充值收入
  app.get('/stats', async (request, reply) => {
    const parsed = AdminStatsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: '统计筛选参数无效' });
    }
    return getAdminGlobalStats({
      rechargeRange: parsed.data.recharge_range,
      rechargeStartDate: parsed.data.recharge_start_date,
      rechargeEndDate: parsed.data.recharge_end_date,
    });
  });

  // GET /api/admin/status — 管理后台完整运行状态统计
  app.get('/status', async () => getAdminStatusOverview());

  app.get('/system-config', async () => getSystemConfigOverview());

  app.put('/system-config/model', async (request, reply) => {
    const parsed = OfficialModelSettingsSchema.safeParse(request.body, {
      error: () => '模型配置参数不正确',
    });
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message || '模型配置参数不正确',
      });
    }
    return saveOfficialModelSettings({ ...parsed.data, actor: 'manager' });
  });

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

  // DELETE /api/admin/users/:id/logs — 清空某个用户的全部对话日志
  app.delete('/users/:id/logs', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = await getUserById(id);
    if (!user) {
      return reply.code(404).send({ error: '用户不存在' });
    }
    const deletedCount = await deleteConversationLogsForAdminUser(id);
    return { success: true, deleted_count: deletedCount };
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

  // GET /api/admin/messages — 查询消息（支持按用户/账号筛选、分页）
  app.get('/messages', async (request) => {
    const query = request.query as {
      account_id?: string;
      user_id?: string;
      session_id?: string;
      limit?: string;
      offset?: string;
    };
    return getMessagesForAdmin({
      accountId: query.account_id,
      userId: query.user_id,
      sessionId: query.session_id,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    });
  });

  // GET /api/admin/chat-sessions — 查询网页对话窗口（支持按用户/账号筛选、分页）
  app.get('/chat-sessions', async (request) => {
    const query = request.query as {
      account_id?: string;
      user_id?: string;
      limit?: string;
      offset?: string;
    };
    return getChatSessionsForAdmin({
      accountId: query.account_id,
      userId: query.user_id,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    });
  });

  // GET /api/admin/chat-sessions/:sessionId — 查看任意会话完整内容（消息 + 卦象 + 关联客户）
  // 权限：admin:*（不在 user_manager 允许表内，仅 owner 可用；含 tool_context 等高敏感字段）
  app.get<{ Params: { sessionId: string } }>(
    '/chat-sessions/:sessionId',
    async (request, reply) => {
      const { sessionId } = request.params;
      const result = await getAdminChatSessionDetail(sessionId);
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );

  // POST /api/admin/chat-sessions/pi-sessions/cleanup — 清理站内 AI Chat 的 Pi session 本地文件
  app.post('/chat-sessions/pi-sessions/cleanup', async (request, reply) => {
    const parsed = PiSessionCleanupSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    return cleanupPiSessionFilesForAdmin({
      mode: parsed.data.mode,
      inactiveDays: parsed.data.inactive_days,
      limit: parsed.data.limit,
    });
  });

  // POST /api/admin/chat-sessions/pi-sessions/orphans/scan — 审计/删除安全的 Pi session 孤儿文件
  app.post(
    '/chat-sessions/pi-sessions/orphans/scan',
    async (request, reply) => {
      const parsed = PiSessionOrphanScanSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message || '参数错误' });
      }
      return scanPiSessionOrphanFilesForAdmin({
        action: parsed.data.action,
        limit: parsed.data.limit,
        sampleLimit: parsed.data.sample_limit,
      });
    },
  );

  // GET /api/admin/skills/custom — 查看所有用户自定义知识技能
  app.get('/skills/custom', async (request) => {
    const query = request.query as {
      user_id?: string;
    };
    return getCustomSkillsForAdmin({
      userId: query.user_id,
    });
  });

  // GET /api/admin/skills/custom/:id — 查看单个用户自定义知识技能详情
  app.get<{ Params: { id: string } }>(
    '/skills/custom/:id',
    async (request, reply) => {
      const { id } = request.params;
      const skill = await getCustomSkillForAdmin(id);
      if (!skill) {
        return reply.code(404).send({ error: '技能不存在' });
      }
      return skill;
    },
  );

  // PATCH /api/admin/skills/custom/:id/state — 管理员修改用户自定义技能状态/可见性
  app.patch<{
    Params: { id: string };
    Body: {
      enabled?: boolean;
      visibility?: 'private' | 'link_shared' | 'shared';
    };
  }>('/skills/custom/:id/state', async (request, reply) => {
    const { id } = request.params;
    const { enabled, visibility } = request.body || {};

    if (enabled === undefined && visibility === undefined) {
      return reply
        .code(400)
        .send({ error: 'enabled 或 visibility 至少提供一个' });
    }
    if (
      visibility !== undefined &&
      !['private', 'link_shared', 'shared'].includes(visibility)
    ) {
      return reply.code(400).send({ error: 'visibility 值无效' });
    }

    const current = await getUserCustomSkillById(id);
    if (!current) {
      return reply.code(404).send({ error: '技能不存在' });
    }

    await setUserCustomSkillAdminState(id, {
      enabled,
      visibility,
      shareToken:
        visibility && visibility !== 'private' && !current.share_token
          ? crypto.randomUUID()
          : current.share_token,
    });

    const updated = await getCustomSkillForAdmin(id);
    if (!updated) {
      return reply.code(404).send({ error: '技能不存在' });
    }
    return updated;
  });

  // GET /api/admin/skills/comments — 管理员查看 Skill 评论审核列表
  app.get('/skills/comments', async (request, reply) => {
    const query = request.query as {
      status?: string;
      skill_id?: string;
      limit?: string;
    };
    const status = query.status?.trim();
    if (status && !['pending', 'approved', 'rejected'].includes(status)) {
      return reply.code(400).send({ error: 'status 值无效' });
    }
    const rawLimit = query.limit ? Number(query.limit) : undefined;
    if (
      rawLimit !== undefined &&
      (!Number.isInteger(rawLimit) || rawLimit < 1)
    ) {
      return reply.code(400).send({ error: 'limit 必须是正整数' });
    }

    const comments = await listSkillCommentsForAdmin({
      status: status as 'pending' | 'approved' | 'rejected' | undefined,
      skillId: query.skill_id?.trim() || undefined,
      limit: rawLimit,
    });
    return { items: toAdminSkillCommentDtos(comments) };
  });

  // PATCH /api/admin/skills/comments/:id/review — 管理员通过或拒绝评论
  app.patch<{
    Params: { id: string };
    Body: { status?: 'pending' | 'approved' | 'rejected' };
  }>('/skills/comments/:id/review', async (request, reply) => {
    const status = request.body?.status;
    if (!['approved', 'rejected'].includes(status ?? '')) {
      return reply
        .code(400)
        .send({ error: 'status 只能是 approved 或 rejected' });
    }
    const comment = await reviewSkillCommentForAdmin({
      id: request.params.id,
      status: status as 'approved' | 'rejected',
      reviewedBy: request.adminPrincipal?.role ?? 'admin',
    });
    if (!comment) return reply.code(404).send({ error: '评论不存在' });
    return toAdminSkillCommentDto(comment);
  });

  // PATCH /api/admin/skills/comments/:id/pin — 管理员置顶或取消置顶已通过评论
  app.patch<{
    Params: { id: string };
    Body: { pinned?: boolean };
  }>('/skills/comments/:id/pin', async (request, reply) => {
    if (typeof request.body?.pinned !== 'boolean') {
      return reply.code(400).send({ error: 'pinned 必须是布尔值' });
    }
    const comment = await setSkillCommentPinnedForAdmin(
      request.params.id,
      request.body.pinned,
    );
    if (!comment) {
      return reply.code(404).send({ error: '评论不存在或尚未通过审核' });
    }
    return toAdminSkillCommentDto(comment);
  });

  // GET /api/admin/skills/global — 查看所有系统排盘的全局开关状态
  // 以文件系统为主，数据库配置为辅
  app.get('/skills/global', async () => {
    return listAdminGlobalSkills();
  });

  // POST /api/admin/skills/global/:name/enable — 全局开启一个系统排盘
  app.post<{ Params: { name: string } }>(
    '/skills/global/:name/enable',
    async (request, reply) => {
      const { name } = request.params;
      if (!hasOfficialSkill(name)) {
        return reply.code(404).send({ error: `系统排盘 "${name}" 不存在` });
      }
      await setSkillGlobalEnabled(name, true);

      return { success: true };
    },
  );

  // POST /api/admin/skills/global/:name/disable — 全局关闭一个系统排盘
  app.post<{ Params: { name: string } }>(
    '/skills/global/:name/disable',
    async (request, reply) => {
      const { name } = request.params;
      if (!hasOfficialSkill(name)) {
        return reply.code(404).send({ error: `系统排盘 "${name}" 不存在` });
      }
      await setSkillGlobalEnabled(name, false);

      return { success: true };
    },
  );

  // GET /api/admin/logs?accountId=xxx&limit=20&before=xxx — 查看完整对话日志
  app.get<{
    Querystring: { accountId?: string; limit?: string; before?: string };
  }>('/logs', async (request, reply) => {
    const { accountId, limit: limitStr, before } = request.query;
    if (!accountId) {
      return reply.code(400).send({ error: '缺少 accountId 参数' });
    }
    const limit = Math.min(parseInt(limitStr || '20', 10) || 20, 100);
    return getConversationLogSummaries(accountId, limit, before || undefined);
  });

  // GET /api/admin/logs/:logId — 查看单条完整日志
  app.get<{ Params: { logId: string } }>(
    '/logs/:logId',
    async (request, reply) => {
      const log = await getConversationLogById(request.params.logId);
      if (!log) {
        return reply.code(404).send({ error: '日志不存在' });
      }
      return log;
    },
  );

  // GET /api/admin/logs/by-request/:requestId — 按 requestId 精确定位单条日志
  //
  // **注意**：本接口返回的 trace_events 包含 tool_call args、prompt preview 等
  // 高敏感数据，仅限 admin 排障使用。鉴权由路由前缀的全局 onRequest hook
  // （x-admin-key 校验）保证，不要把此接口暴露到普通用户路径。
  app.get<{ Params: { requestId: string } }>(
    '/logs/by-request/:requestId',
    async (request, reply) => {
      const log = await getConversationLogByRequestId(request.params.requestId);
      if (!log) {
        return reply.code(404).send({ error: '日志不存在' });
      }
      return log;
    },
  );
}
