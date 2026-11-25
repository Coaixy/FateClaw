import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runtimeConfigRoutes } from './runtime-config-routes.js';
import {
  getAdminGlobalStats,
  getSystemConfigOverview,
  saveOfficialModelSettings,
  getAdminStatusOverview,
} from '#modules/admin/admin-service';
import {
  MAX_CONFIGURED_CONTEXT_WINDOW_TOKENS,
  MIN_CONFIGURED_CONTEXT_WINDOW_TOKENS,
} from '#shared/model-context-window';
import { PI_THINKING_LEVELS } from '#shared/types';
import { collectRuntimeStatus } from '#runtime/runtime-status';

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
    revision: z.number().int().positive().optional(),
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

const BenefitModelSettingsSchema = z.strictObject({
  display_name: z.string().trim().min(1).max(120),
  thinking_level: z.enum(PI_THINKING_LEVELS),
  input_token_price_per_million_coins: z.literal(0),
  output_token_price_per_million_coins: z.literal(0),
  revision: z.number().int().positive(),
  enabled: z.boolean(),
  nodes: z.array(OfficialModelPoolNodeSchema).max(20),
  benefit_policy: z.strictObject({
    daily_turns: z.number().int().min(1).max(100),
    concurrency_limit: z.number().int().min(1).max(10),
  }),
});

export async function adminSystemRoutes(app: FastifyInstance): Promise<void> {
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

  await app.register(runtimeConfigRoutes);
  app.get('/system-config', async () => getSystemConfigOverview());
  app.get('/system-config/benefit', async () =>
    getSystemConfigOverview('benefit'),
  );
  app.put('/system-config/benefit', async (request, reply) => {
    const parsed = BenefitModelSettingsSchema.safeParse(request.body, {
      error: () => '免费模型配置参数不正确',
    });
    if (!parsed.success)
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message || '免费模型配置参数不正确',
      });
    return saveOfficialModelSettings(
      { ...parsed.data, actor: 'manager' },
      'benefit',
    );
  });

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
}
