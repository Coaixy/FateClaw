import crypto from 'node:crypto';

import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  BILLING_RESERVATION_STALE_MS,
  MANAGER_KEY,
} from '../../infrastructure/config.js';
import {
  adjustUserPurchasedPoints,
  approveWithdrawal,
  createOfficialModel,
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
  getPointBatchesByUserId,
  getSystemConfigOverview,
  getTasksForAdmin,
  getUserById,
  getUserCustomSkillById,
  getWalletTransactionsByUserId,
  grantBonusPoints,
  hasOfficialSkill,
  createAdminUser,
  listAdminGlobalSkills,
  listAdminUsersWithStats,
  listAdminWithdrawalsMasked,
  listBillingRequestReservations,
  markWithdrawalPaid,
  reconcileStaleBillingReservations,
  removeOfficialModel,
  rejectWithdrawal,
  setOfficialModelSecret,
  setSkillGlobalEnabled,
  setUserCustomSkillAdminState,
  updateOfficialModel,
  updateAdminRechargePaymentConfig,
  getAdminUserDetail,
  getAdminWithdrawalIdNumber,
} from '../../modules/admin/admin-service.js';
import {
  rateLimitCheck,
  rateLimitRecordFail,
  rateLimitClear,
} from './rate-limit.js';
import {
  MAX_CONFIGURED_CONTEXT_WINDOW_TOKENS,
  MIN_CONFIGURED_CONTEXT_WINDOW_TOKENS,
} from '../../shared/model-context-window.js';

const GrantBonusPointsSchema = z.object({
  amount_points: z.number().int().positive('赠送积分必须为正整数'),
  source: z
    .enum(['new_user_gift', 'sign_in', 'admin_grant', 'promotion'])
    .default('admin_grant'),
  note: z.string().max(200).optional(),
  expires_at: z.string().datetime({ offset: true }).nullable().optional(),
});

const AdjustPurchasedPointsSchema = z.object({
  amount_points: z
    .number()
    .int()
    .refine((v) => v !== 0, '调整积分不能为 0'),
  note: z.string().max(200).optional(),
});

const AdminCreateUserSchema = z.object({
  phone: z.string().trim().min(1, '手机号不能为空').max(32),
  password: z.string().min(8, '密码至少 8 位').max(128),
  role: z.enum(['consumer', 'creator', 'both', 'admin']).default('consumer'),
  phone_verified: z.boolean().default(true),
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

const WithdrawalApproveSchema = z.object({
  tax_amount_yuan: z.string().optional(),
  net_amount_yuan: z.string().optional(),
  platform_fee_points: z.number().int().min(0).optional(),
  note: z.string().max(500).optional(),
});

const WithdrawalRejectSchema = z.object({
  note: z.string().min(1).max(500),
});

const WithdrawalPaidSchema = z.object({
  payment_proof: z.string().min(1).max(500),
});

const OfficialModelAuthModeSchema = z
  .enum([
    'openai_api_key',
    'anthropic_api_key',
    'claude_code_oauth_token',
    'gemini_api_key',
  ])
  .optional();

const OfficialModelSchema = z.object({
  model_key: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-_]*$/i, 'model_key 格式不合法'),
  pi_api: z.enum([
    'openai-completions',
    'openai-responses',
    'anthropic-messages',
    'google-generative-ai',
  ]),
  display_name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(999).default(0),
  base_url: z.string().trim().max(500).nullable().optional(),
  model_name: z.string().trim().min(1).max(120),
  context_window_tokens: z
    .number()
    .int()
    .min(0)
    .max(MAX_CONFIGURED_CONTEXT_WINDOW_TOKENS)
    .refine(
      (value) => value === 0 || value >= MIN_CONFIGURED_CONTEXT_WINDOW_TOKENS,
      `context_window_tokens 必须为 0，或不小于 ${MIN_CONFIGURED_CONTEXT_WINDOW_TOKENS}`,
    )
    .nullable()
    .optional(),
  input_token_price_per_million_points: z.number().int().min(0).default(0),
  output_token_price_per_million_points: z.number().int().min(0).default(0),
});

const OfficialModelCreateSchema = OfficialModelSchema.extend({
  api_key: z.string().trim().min(1).max(2000).optional(),
  auth_mode: OfficialModelAuthModeSchema,
});

const OfficialModelSecretSchema = z.object({
  api_key: z.string().trim().min(1).max(2000),
  auth_mode: OfficialModelAuthModeSchema,
});

function toConfiguredContextWindowTokens(
  value: number | null | undefined,
): number | null | undefined {
  if (value === undefined) return undefined;
  return value && value > 0 ? value : null;
}

const RechargeMoneySchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, '金额必须是最多两位小数的正数')
  .refine((value) => Number(value) > 0, '金额必须大于 0')
  .transform((value) => Number(value).toFixed(2));

const RechargePaymentConfigSchema = z
  .object({
    enabled: z.boolean(),
    min_yuan: RechargeMoneySchema,
    max_yuan: RechargeMoneySchema,
    epay_url_prefix: z.string().trim().max(500),
    epay_platform_id: z.number().int().positive().nullable(),
    epay_merchant_private_key: z.string().max(8000),
    epay_platform_public_key: z.string().max(8000),
    epay_merchant_key: z.string().trim().max(1000),
    notify_url: z.string().trim().max(500),
    return_url: z.string().trim().max(500),
  })
  .superRefine((value, ctx) => {
    if (Number(value.max_yuan) < Number(value.min_yuan)) {
      ctx.addIssue({
        code: 'custom',
        path: ['max_yuan'],
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
      ['notify_url', '异步通知地址不能为空'],
      ['return_url', '支付完成返回地址不能为空'],
    ];
    for (const [key, message] of requiredFields) {
      if (!value[key]) {
        ctx.addIssue({ code: 'custom', path: [key], message });
      }
    }
  });

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // 所有 admin 路由需要验证 MANAGER_KEY；登录端点（/verify）额外加指数退避限流
  app.addHook('onRequest', async (request, reply) => {
    if (!MANAGER_KEY) {
      return reply.code(503).send({ error: '管理端未配置密钥' });
    }

    const isVerifyEndpoint = request.url.endsWith('/verify');
    const ipHash = crypto
      .createHash('sha256')
      .update(request.ip)
      .digest('hex')
      .slice(0, 16);
    const rateKey = `admin:${ipHash}`;

    // 只对登录端点做限流，不影响已登录后的业务 API 轮询
    if (isVerifyEndpoint) {
      const check = await rateLimitCheck(rateKey);
      if (!check.allowed) {
        request.log.warn(
          { ipHash, retryAfterMs: check.retryAfterMs },
          'admin verify rate limited',
        );
        return reply
          .code(429)
          .header('Retry-After', Math.ceil((check.retryAfterMs ?? 1000) / 1000))
          .send({ error: '尝试过于频繁，请稍后再试' });
      }
    }

    const key = request.headers['x-admin-key'];
    if (key !== MANAGER_KEY) {
      if (isVerifyEndpoint) {
        await rateLimitRecordFail(rateKey);
      }
      return reply.code(401).send({ error: '管理密钥无效' });
    }

    if (isVerifyEndpoint) {
      await rateLimitClear(rateKey);
    }
  });

  // POST /api/admin/verify — 验证密钥是否正确
  app.post('/verify', async () => {
    return { success: true };
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

  // GET /api/admin/system-config — 官方模型池 / 审计
  app.get('/system-config', async () => {
    return getSystemConfigOverview();
  });

  // GET /api/admin/recharge-config — 读取数据库中的充值配置
  app.get('/recharge-config', async () => {
    return getAdminRechargePaymentConfig();
  });

  // PUT /api/admin/recharge-config — 更新易支付充值配置
  app.put('/recharge-config', async (request, reply) => {
    const parsed = RechargePaymentConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    return updateAdminRechargePaymentConfig(parsed.data);
  });

  // POST /api/admin/system-config/providers — 新建官方模型
  app.post('/system-config/providers', async (request, reply) => {
    const parsed = OfficialModelCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    const provider = await createOfficialModel({
      modelKey: parsed.data.model_key,
      piApi: parsed.data.pi_api,
      displayName: parsed.data.display_name,
      enabled: parsed.data.enabled,
      priority: parsed.data.priority,
      baseUrl: parsed.data.base_url?.trim() || null,
      modelName: parsed.data.model_name,
      contextWindowTokens: toConfiguredContextWindowTokens(
        parsed.data.context_window_tokens,
      ),
      inputTokenPricePerMillionPoints:
        parsed.data.input_token_price_per_million_points,
      outputTokenPricePerMillionPoints:
        parsed.data.output_token_price_per_million_points,
      secretValue: parsed.data.api_key,
      authMode: parsed.data.auth_mode,
      actor: 'manager',
    });
    return provider;
  });

  // PATCH /api/admin/system-config/providers/:id — 更新官方模型
  app.patch('/system-config/providers/:id', async (request, reply) => {
    const parsed = OfficialModelSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    try {
      const provider = await updateOfficialModel({
        id: (request.params as { id: string }).id,
        modelKey: parsed.data.model_key,
        piApi: parsed.data.pi_api,
        displayName: parsed.data.display_name,
        enabled: parsed.data.enabled,
        priority: parsed.data.priority,
        baseUrl: parsed.data.base_url?.trim() || null,
        modelName: parsed.data.model_name,
        contextWindowTokens: toConfiguredContextWindowTokens(
          parsed.data.context_window_tokens,
        ),
        inputTokenPricePerMillionPoints:
          parsed.data.input_token_price_per_million_points,
        outputTokenPricePerMillionPoints:
          parsed.data.output_token_price_per_million_points,
        actor: 'manager',
      });
      return provider;
    } catch (error) {
      return reply
        .code(404)
        .send({ error: error instanceof Error ? error.message : '更新失败' });
    }
  });

  // POST /api/admin/system-config/providers/:id/secret — 保存官方模型密钥
  app.post('/system-config/providers/:id/secret', async (request, reply) => {
    const parsed = OfficialModelSecretSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    try {
      await setOfficialModelSecret({
        modelId: (request.params as { id: string }).id,
        secretValue: parsed.data.api_key,
        authMode: parsed.data.auth_mode,
        actor: 'manager',
      });
      return { success: true };
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : '保存失败' });
    }
  });

  // DELETE /api/admin/system-config/providers/:id — 删除官方模型
  app.delete('/system-config/providers/:id', async (request, reply) => {
    try {
      await removeOfficialModel(
        (request.params as { id: string }).id,
        'manager',
      );
      return { success: true };
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : '删除失败' });
    }
  });

  // GET /api/admin/users — 获取所有用户（附带用量和账号数）
  app.get('/users', async () => {
    return listAdminUsersWithStats();
  });

  // POST /api/admin/users — 管理员直接创建用户，不走短信验证码
  app.post('/users', async (request, reply) => {
    const body = AdminCreateUserSchema.parse(request.body);
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

  // GET /api/admin/users/:id/transactions — 最近余额流水
  app.get('/users/:id/transactions', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = await getUserById(id);
    if (!user) {
      return reply.code(404).send({ error: '用户不存在' });
    }
    return getWalletTransactionsByUserId(id, 50);
  });

  // POST /api/admin/users/:id/points/grant — 管理员发放赠送积分（带过期时间）
  app.post('/users/:id/points/grant', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = GrantBonusPointsSchema.parse(request.body);
    const user = await getUserById(id);
    if (!user) {
      return reply.code(404).send({ error: '用户不存在' });
    }
    const { user: updated, batchId } = await grantBonusPoints({
      userId: id,
      source: body.source,
      amountPoints: body.amount_points,
      expiresAt: body.expires_at ?? null,
      note: body.note ?? null,
      grantedBy: request.user?.userId ?? 'admin',
    });
    return {
      success: true,
      batch_id: batchId,
      bonus_points: updated.bonus_points,
      purchased_points: updated.purchased_points,
      earned_points: updated.earned_points,
      reserved_points: updated.reserved_points,
    };
  });

  // POST /api/admin/users/:id/points/adjust — 管理员调整用户充值积分（正数=充值，负数=扣减）
  app.post('/users/:id/points/adjust', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = AdjustPurchasedPointsSchema.parse(request.body);
    const user = await getUserById(id);
    if (!user) {
      return reply.code(404).send({ error: '用户不存在' });
    }
    const updated = await adjustUserPurchasedPoints(
      id,
      body.amount_points,
      body.note,
    );
    return {
      success: true,
      purchased_points: updated.purchased_points,
      bonus_points: updated.bonus_points,
      earned_points: updated.earned_points,
      reserved_points: updated.reserved_points,
      available_points: Math.max(
        0,
        updated.purchased_points +
          updated.bonus_points -
          updated.reserved_points,
      ),
    };
  });

  // GET /api/admin/users/:id/points/batches — 查看用户赠送积分批次
  app.get('/users/:id/points/batches', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as {
      include_exhausted?: string;
      limit?: string;
    };
    const user = await getUserById(id);
    if (!user) {
      return reply.code(404).send({ error: '用户不存在' });
    }
    return getPointBatchesByUserId(id, {
      includeExhausted: query.include_exhausted === 'true',
      limit: query.limit ? Number(query.limit) : undefined,
    });
  });

  // GET /api/admin/withdrawals — 查询提现申请（默认按状态过滤）
  app.get('/withdrawals', async (request) => {
    const query = request.query as {
      status?: 'pending' | 'approved' | 'rejected' | 'paid' | 'cancelled';
      creator_id?: string;
      limit?: string;
    };
    return listAdminWithdrawalsMasked({
      status: query.status,
      creatorId: query.creator_id,
      limit: query.limit ? Number(query.limit) : undefined,
    });
  });

  // GET /api/admin/withdrawals/:id/id-number — 解密并返回身份证号明文
  // 单独端点以便审计（后续可加调用日志），避免列表接口无差别泄露
  app.get('/withdrawals/:id/id-number', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await getAdminWithdrawalIdNumber(id);
    if (!result) return reply.code(404).send({ error: '提现申请不存在' });
    try {
      return result;
    } catch (err) {
      return reply.code(500).send({
        error: '身份证号解密失败',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /api/admin/withdrawals/:id/approve — 审核通过（扣 earned_points）
  app.post('/withdrawals/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = WithdrawalApproveSchema.parse(request.body);
    try {
      const wd = await approveWithdrawal({
        withdrawalId: id,
        reviewedBy: request.user?.userId ?? 'admin',
        taxAmountYuan: body.tax_amount_yuan,
        netAmountYuan: body.net_amount_yuan,
        platformFeePoints: body.platform_fee_points,
        note: body.note ?? null,
      });
      return { success: true, withdrawal: wd };
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : '审核失败' });
    }
  });

  // POST /api/admin/withdrawals/:id/reject — 驳回（解冻 pending）
  app.post('/withdrawals/:id/reject', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = WithdrawalRejectSchema.parse(request.body);
    try {
      const wd = await rejectWithdrawal({
        withdrawalId: id,
        reviewedBy: request.user?.userId ?? 'admin',
        note: body.note,
      });
      return { success: true, withdrawal: wd };
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : '驳回失败' });
    }
  });

  // POST /api/admin/withdrawals/:id/mark-paid — 标记已打款（记录凭证）
  app.post('/withdrawals/:id/mark-paid', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = WithdrawalPaidSchema.parse(request.body);
    try {
      const wd = await markWithdrawalPaid({
        withdrawalId: id,
        paymentProof: body.payment_proof,
      });
      return { success: true, withdrawal: wd };
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : '标记失败' });
    }
  });

  // GET /api/admin/billing/reservations — 查询请求级预留记录
  app.get('/billing/reservations', async (request) => {
    const query = request.query as {
      user_id?: string;
      hold_state?: 'none' | 'held' | 'released';
      charge_state?: 'pending' | 'charged';
      limit?: string;
    };
    return listBillingRequestReservations({
      userId: query.user_id,
      holdState: query.hold_state,
      chargeState: query.charge_state,
      limit: query.limit ? Number(query.limit) : undefined,
    });
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

  // GET /api/admin/tasks — 查询所有定时任务（支持按用户/状态筛选）
  app.get('/tasks', async (request) => {
    const query = request.query as {
      user_id?: string;
      status?: string;
    };
    return getTasksForAdmin({
      userId: query.user_id,
      status: query.status,
    });
  });

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
