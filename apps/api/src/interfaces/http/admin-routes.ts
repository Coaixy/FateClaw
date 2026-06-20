import crypto from 'node:crypto';

import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  BILLING_RESERVATION_STALE_MS,
  MANAGER_KEY,
  USER_MANAGER_KEY,
} from '../../infrastructure/config.js';
import {
  adjustUserPurchasedBalance,
  cancelAdminUserMembership,
  createAnnouncement,
  createOfficialModel,
  deleteConversationLogsForAdminUser,
  deleteDraftAnnouncement,
  deleteUser,
  getAdminGlobalStats,
  getAdminAnnouncementById,
  getAdminRechargePaymentConfig,
  getChatSessionsForAdmin,
  getConversationLogById,
  getConversationLogByRequestId,
  getConversationLogSummaries,
  getCustomSkillForAdmin,
  getCustomSkillsForAdmin,
  getMessagesForAdmin,
  getBalanceGrantsByUserId,
  getAdminReferralConfig,
  getSystemConfigOverview,
  getUserById,
  getUserCustomSkillById,
  getWalletTransactionsByUserId,
  grantBonusBalance,
  hasOfficialSkill,
  createAdminUser,
  cleanupPiSessionFilesForAdmin,
  scanPiSessionOrphanFilesForAdmin,
  listAdminGlobalSkills,
  listAdminWorkflowSkillSummaries,
  listSkillCommentsForAdmin,
  listAdminUsersWithStats,
  listBillingRequestReservations,
  listBillingRequestReservationsPageForAdmin,
  listRechargeOrdersForAdmin,
  listAdminReferrals,
  listWalletTransactionsForAdmin,
  listSimpleWorkflowPresets,
  reconcileStaleBillingReservations,
  removeOfficialModel,
  resetAdminUserPassword,
  setAdminUserMembership,
  setSkillGlobalEnabled,
  setSkillCommentPinnedForAdmin,
  setUserCustomSkillAdminState,
  reviewSkillCommentForAdmin,
  updateModelBillingSettings,
  updateOfficialModel,
  updateRuntimeSettings,
  updateAdminRechargePaymentConfig,
  updateAdminReferralConfig,
  getAdminUserDetail,
  createPublicFinancialLedgerEntry,
  deletePublicFinancialLedgerEntry,
  listAdminAnnouncements,
  listPublicFinancialLedgerEntries,
  getAdminStatusOverview,
  updateAnnouncement,
  updatePublicFinancialLedgerEntry,
  updateSimpleWorkflowPreset,
} from '../../modules/admin/admin-service.js';
import {
  toAdminSkillCommentDto,
  toAdminSkillCommentDtos,
} from '../../contracts-adapter/skills-contract.js';
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
import { ACTIVE_MEMBERSHIP_PLAN_KEYS } from '../../shared/membership-plans.js';
import { calculateAvailableSpendableCoins } from '../../shared/balance-coins.js';
import { resolvePaymentCallbackUrls } from './payment-callback-urls.js';

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

function roundCoinsToCents(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Object.is(value, -0) ? 0 : Math.round(value * 100) / 100;
}

function hasAtMostTwoDecimalPlaces(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-8;
}

const SoftCurrencyNumberSchema = z
  .number()
  .refine(Number.isFinite, '金额格式不正确')
  .refine(hasAtMostTwoDecimalPlaces, '金额最多支持 2 位小数')
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

const MembershipPlanKeySchema = z.enum(ACTIVE_MEMBERSHIP_PLAN_KEYS);

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

const SimpleModelPolicySchema = z.object({
  mode: z.enum(['system-default', 'user-current', 'fixed']),
  fixedModelId: z.string().trim().min(1).max(120).optional(),
  thinkingLevel: z.enum(['off', 'low', 'medium', 'high', 'xhigh']).optional(),
});

const SimpleWorkflowPresetUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  is_default: z.boolean().optional(),
  entry_title: z.string().trim().min(1).max(40).optional(),
  entry_description: z.string().trim().max(240).optional(),
  paipan_input_defaults: z.record(z.string(), z.unknown()).optional(),
  model_policy: SimpleModelPolicySchema.optional(),
  skill_bundle_ids: z.array(z.string().trim().min(1)).max(50).optional(),
  skill_ids: z.array(z.string().trim().min(1)).max(100).optional(),
  prompt_template: z.string().trim().min(1).max(4000).optional(),
  sort_order: z.number().int().min(0).max(10000).optional(),
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
  description: z.string().trim().max(240).optional(),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(999).default(0),
  base_url: z.string().trim().max(500).nullable().optional(),
  model_name: z.string().trim().min(1).max(120),
  api_key: z.string().trim().max(2000).optional(),
  auth_mode: OfficialModelAuthModeSchema,
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
  input_token_price_per_million_coins: z.number().int().min(0).default(0),
  output_token_price_per_million_coins: z.number().int().min(0).default(0),
});

const OfficialModelCreateSchema = OfficialModelSchema.extend({
  api_key: z.string().trim().min(1).max(2000),
});

const ModelBillingSchema = z.object({
  custom_model_platform_price_per_million_coins: z
    .number()
    .int()
    .min(0)
    .max(1_000_000),
});

const RuntimeConfigSchema = z
  .object({
    agent_concurrency_limit: z
      .number()
      .int('并发上限必须是整数')
      .min(1, '并发上限必须至少为 1')
      .max(1000, '并发上限不能超过 1000'),
    local_agent_max_processes: z
      .number()
      .int('常驻进程上限必须是整数')
      .min(1, '常驻进程上限必须至少为 1')
      .max(100, '常驻进程上限不能超过 100')
      .optional(),
    local_agent_idle_ttl_ms: z
      .number()
      .int('空闲回收时间必须是整数')
      .min(30_000, '空闲回收时间不能少于 30 秒')
      .max(86_400_000, '空闲回收时间不能超过 24 小时')
      .optional(),
    default_official_model_id: z
      .string()
      .trim()
      .min(1, '默认官方模型不能为空')
      .max(120, '默认官方模型 ID 过长')
      .nullable()
      .optional(),
    default_thinking_level: z.enum(PI_THINKING_LEVELS).optional(),
    pi_session_health_enabled: z.boolean().optional(),
    pi_session_inactive_cleanup_days: z
      .number()
      .int('Pi session 未活跃清理天数必须是整数')
      .min(1, 'Pi session 未活跃清理天数不能少于 1 天')
      .max(3650, 'Pi session 未活跃清理天数不能超过 3650 天')
      .optional(),
    pi_session_orphan_grace_days: z
      .number()
      .int('Pi session 孤儿文件保护天数必须是整数')
      .min(1, 'Pi session 孤儿文件保护天数不能少于 1 天')
      .max(3650, 'Pi session 孤儿文件保护天数不能超过 3650 天')
      .optional(),
    user_skill_max_count: z
      .number()
      .int('用户 Skill 数量上限必须是整数')
      .min(1, '用户 Skill 数量上限不能少于 1 个')
      .max(500, '用户 Skill 数量上限不能超过 500 个')
      .optional(),
    skill_bundle_max_files: z
      .number()
      .int('Skill 文件数上限必须是整数')
      .min(1, 'Skill 文件数上限不能少于 1 个')
      .max(500, 'Skill 文件数上限不能超过 500 个')
      .optional(),
    skill_bundle_max_file_chars: z
      .number()
      .int('Skill 单文件字符上限必须是整数')
      .min(1, 'Skill 单文件字符上限不能少于 1 字')
      .max(2_000_000, 'Skill 单文件字符上限不能超过 2000000 字')
      .optional(),
    skill_bundle_max_total_chars: z
      .number()
      .int('Skill 总字符上限必须是整数')
      .min(1, 'Skill 总字符上限不能少于 1 字')
      .max(10_000_000, 'Skill 总字符上限不能超过 10000000 字')
      .optional(),
    skill_bundle_max_zip_bytes: z
      .number()
      .int('Skill ZIP 体积上限必须是整数')
      .min(1024, 'Skill ZIP 体积上限不能少于 1KB')
      .max(100 * 1024 * 1024, 'Skill ZIP 体积上限不能超过 100MB')
      .optional(),
  })
  .superRefine((config, ctx) => {
    if (
      config.skill_bundle_max_file_chars !== undefined &&
      config.skill_bundle_max_total_chars !== undefined &&
      config.skill_bundle_max_total_chars < config.skill_bundle_max_file_chars
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['skill_bundle_max_total_chars'],
        message: 'Skill 总字符上限不能小于单文件字符上限',
      });
    }
  });

function toConfiguredContextWindowTokens(
  value: number | null | undefined,
): number | null | undefined {
  if (value === undefined) return undefined;
  return value && value > 0 ? value : null;
}

function isOfficialModelKeyConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  // PostgreSQL 唯一约束冲突时返回 23505；这里转成前端可读的模型重复错误。
  return (
    record.code === '23505' &&
    (record.constraint === 'official_model_configs_model_key_key' ||
      String(record.detail ?? '').includes('model_key'))
  );
}

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

const ReferralConfigSchema = z.object({
  enabled: z.boolean(),
  reward_membership_plan_key: z.enum(ACTIVE_MEMBERSHIP_PLAN_KEYS).optional(),
  inviter_reward_days: z
    .number()
    .int('奖励天数必须是整数')
    .min(0, '奖励天数不能小于 0')
    .max(366, '奖励天数不能超过 366'),
  monthly_reward_cap_days: z
    .number()
    .int('月度封顶天数必须是整数')
    .min(0, '月度封顶天数不能小于 0')
    .max(3660, '月度封顶天数不能超过 3660'),
  reward_first_membership_only: z.boolean().optional(),
  invite_count_reward_threshold: z
    .number()
    .int('累计邀请门槛必须是整数')
    .min(0, '累计邀请门槛不能小于 0')
    .max(1_000_000, '累计邀请门槛过大')
    .optional(),
  invite_count_reward_days: z
    .number()
    .int('累计邀请奖励天数必须是整数')
    .min(0, '累计邀请奖励天数不能小于 0')
    .max(366, '累计邀请奖励天数不能超过 366')
    .optional(),
  invite_count_reward_max_invites: z
    .number()
    .int('累计邀请人数上限必须是整数')
    .min(0, '累计邀请人数上限不能小于 0')
    .max(1_000_000, '累计邀请人数上限过大')
    .optional(),
});

const AdminReferralsQuerySchema = z.object({
  inviter_id: z.string().trim().optional(),
  invitee_id: z.string().trim().optional(),
  reward_status: z
    .enum(['pending', 'granted', 'skipped', 'ineligible'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const PublicFinancialLedgerEntrySchema = z.object({
  entry_type: z.enum(['income', 'expense']),
  occurred_at: DateOnlySchema,
  content: z.string().trim().min(1, '内容不能为空').max(200, '内容最多 200 字'),
  amount_yuan: SoftCurrencyNumberSchema.refine(
    (value) => value > 0,
    '数额必须大于 0',
  ),
});

function nullableDateTimeSchema(label: string) {
  return z
    .string()
    .trim()
    .datetime({ offset: true, message: `${label}格式不正确` })
    .nullable()
    .optional();
}

function isSafeAnnouncementCtaHref(value: string): boolean {
  return (
    (value.startsWith('/') && !value.startsWith('//')) ||
    value.startsWith('https://')
  );
}

function isUniqueAnnouncementSlugConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  return (
    record.code === '23505' &&
    (record.constraint === 'announcements_slug_key' ||
      String(record.detail ?? '').includes('slug'))
  );
}

function validateAnnouncementCta(
  value: { cta_label?: string | null; cta_href?: string | null },
  ctx: z.RefinementCtx,
) {
  const hasLabel = Boolean(value.cta_label);
  const hasHref = Boolean(value.cta_href);
  if (hasLabel !== hasHref) {
    ctx.addIssue({
      code: 'custom',
      path: hasLabel ? ['cta_href'] : ['cta_label'],
      message: 'CTA 文案和链接必须同时填写或同时留空',
    });
    return;
  }
  if (value.cta_href && !isSafeAnnouncementCtaHref(value.cta_href)) {
    ctx.addIssue({
      code: 'custom',
      path: ['cta_href'],
      message: 'CTA 链接只允许站内路径或 https:// 外链',
    });
  }
}

function validateAnnouncementWindow(
  value: { starts_at?: string | null; ends_at?: string | null },
  ctx: z.RefinementCtx,
) {
  if (!value.starts_at || !value.ends_at) return;
  if (
    new Date(value.ends_at).getTime() <= new Date(value.starts_at).getTime()
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['ends_at'],
      message: '结束时间必须晚于开始时间',
    });
  }
}

const AnnouncementBaseSchema = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(120, '标题最多 120 字'),
  summary: z.string().trim().max(280, '摘要最多 280 字').default(''),
  body_markdown: z
    .string()
    .trim()
    .min(1, 'Markdown 正文不能为空')
    .max(20_000, 'Markdown 正文最多 20000 字'),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  priority: z.number().int('优先级必须是整数').min(0).max(1_000_000).default(0),
  starts_at: nullableDateTimeSchema('开始时间'),
  ends_at: nullableDateTimeSchema('结束时间'),
  cta_label: z
    .string()
    .trim()
    .min(1)
    .max(40, 'CTA 文案最多 40 字')
    .nullable()
    .optional(),
  cta_href: z
    .string()
    .trim()
    .min(1)
    .max(500, 'CTA 链接最多 500 字')
    .nullable()
    .optional(),
});

const AnnouncementCreateSchema = AnnouncementBaseSchema.superRefine(
  (value, ctx) => {
    validateAnnouncementWindow(value, ctx);
    validateAnnouncementCta(value, ctx);
  },
);

const AnnouncementUpdateSchema = z
  .object({
    title: AnnouncementBaseSchema.shape.title,
    summary: z.string().trim().max(280, '摘要最多 280 字'),
    body_markdown: AnnouncementBaseSchema.shape.body_markdown,
    status: z.enum(['draft', 'published', 'archived']),
    priority: z.number().int('优先级必须是整数').min(0).max(1_000_000),
    starts_at: nullableDateTimeSchema('开始时间'),
    ends_at: nullableDateTimeSchema('结束时间'),
    cta_label: AnnouncementBaseSchema.shape.cta_label,
    cta_href: AnnouncementBaseSchema.shape.cta_href,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: '至少需要提供一个更新字段',
  });

function getAnnouncementStateError(value: {
  starts_at?: string | null;
  ends_at?: string | null;
  cta_label?: string | null;
  cta_href?: string | null;
}): string | null {
  if (
    value.starts_at &&
    value.ends_at &&
    new Date(value.ends_at).getTime() <= new Date(value.starts_at).getTime()
  ) {
    return '结束时间必须晚于开始时间';
  }

  const hasLabel = Boolean(value.cta_label);
  const hasHref = Boolean(value.cta_href);
  if (hasLabel !== hasHref) {
    return 'CTA 文案和链接必须同时填写或同时留空';
  }
  if (value.cta_href && !isSafeAnnouncementCtaHref(value.cta_href)) {
    return 'CTA 链接只允许站内路径或 https:// 外链';
  }
  return null;
}

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

  // GET /api/admin/system-config — 官方模型池 / 审计
  app.get('/system-config', async () => {
    return getSystemConfigOverview();
  });

  // PUT /api/admin/system-config/model-billing — 更新自配模型平台服务费
  app.put('/system-config/model-billing', async (request, reply) => {
    const parsed = ModelBillingSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    return updateModelBillingSettings({
      customModelPlatformPricePerMillionCoins:
        parsed.data.custom_model_platform_price_per_million_coins,
      actor: 'manager',
    });
  });

  // PUT /api/admin/system-config/runtime — 更新 Agent 运行时配置
  app.put('/system-config/runtime', async (request, reply) => {
    const parsed = RuntimeConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    try {
      return await updateRuntimeSettings({
        agentConcurrencyLimit: parsed.data.agent_concurrency_limit,
        localAgentMaxProcesses: parsed.data.local_agent_max_processes,
        localAgentIdleTtlMs: parsed.data.local_agent_idle_ttl_ms,
        defaultOfficialModelId: parsed.data.default_official_model_id,
        defaultThinkingLevel: parsed.data.default_thinking_level,
        piSessionHealthEnabled: parsed.data.pi_session_health_enabled,
        piSessionInactiveCleanupDays:
          parsed.data.pi_session_inactive_cleanup_days,
        piSessionOrphanGraceDays: parsed.data.pi_session_orphan_grace_days,
        userSkillMaxCount: parsed.data.user_skill_max_count,
        skillBundleMaxFiles: parsed.data.skill_bundle_max_files,
        skillBundleMaxFileChars: parsed.data.skill_bundle_max_file_chars,
        skillBundleMaxTotalChars: parsed.data.skill_bundle_max_total_chars,
        skillBundleMaxZipBytes: parsed.data.skill_bundle_max_zip_bytes,
        actor: 'manager',
      });
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : '更新运行时配置失败',
      });
    }
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

  // GET /api/admin/referrals/config — 读取邀请返利配置
  app.get('/referrals/config', async () => {
    return getAdminReferralConfig();
  });

  // PUT /api/admin/referrals/config — 更新邀请返利配置
  app.put('/referrals/config', async (request, reply) => {
    const parsed = ReferralConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    return updateAdminReferralConfig({
      enabled: parsed.data.enabled,
      rewardMembershipPlanKey: parsed.data.reward_membership_plan_key,
      inviterRewardDays: parsed.data.inviter_reward_days,
      monthlyRewardCapDays: parsed.data.monthly_reward_cap_days,
      rewardFirstMembershipOnly:
        parsed.data.reward_first_membership_only ?? true,
      inviteCountRewardThreshold:
        parsed.data.invite_count_reward_threshold ?? 10,
      inviteCountRewardDays: parsed.data.invite_count_reward_days ?? 7,
      inviteCountRewardMaxInvites:
        parsed.data.invite_count_reward_max_invites ?? 50,
    });
  });

  // GET /api/admin/referrals — 查询邀请关系
  app.get('/referrals', async (request, reply) => {
    const parsed = AdminReferralsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    return listAdminReferrals({
      inviterId: parsed.data.inviter_id || undefined,
      inviteeId: parsed.data.invitee_id || undefined,
      rewardStatus: parsed.data.reward_status,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
  });

  // GET /api/admin/simple-workflows — 查看简易模式 workflow preset
  app.get('/simple-workflows', async () => {
    return { presets: await listSimpleWorkflowPresets() };
  });

  // GET /api/admin/simple-workflows/resources — 简易模式配置可选资源
  app.get('/simple-workflows/resources', async () => {
    return { skills: await listAdminWorkflowSkillSummaries() };
  });

  // PATCH /api/admin/simple-workflows/:id — 更新简易模式 workflow preset
  app.patch('/simple-workflows/:id', async (request, reply) => {
    const parsed = SimpleWorkflowPresetUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    const updated = await updateSimpleWorkflowPreset({
      id: (request.params as { id: string }).id,
      name: parsed.data.name,
      enabled: parsed.data.enabled,
      isDefault: parsed.data.is_default,
      entryTitle: parsed.data.entry_title,
      entryDescription: parsed.data.entry_description,
      paipanInputDefaults: parsed.data.paipan_input_defaults,
      modelPolicy: parsed.data.model_policy,
      skillBundleIds: parsed.data.skill_bundle_ids,
      skillIds: parsed.data.skill_ids,
      promptTemplate: parsed.data.prompt_template,
      sortOrder: parsed.data.sort_order,
    });
    if (!updated) {
      return reply.code(404).send({ error: '简易模式 workflow 不存在' });
    }
    return updated;
  });

  // GET /api/admin/announcements — 公告管理列表
  app.get('/announcements', async () => {
    return { announcements: await listAdminAnnouncements() };
  });

  // POST /api/admin/announcements — 创建公告
  app.post('/announcements', async (request, reply) => {
    const parsed = AnnouncementCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    try {
      const announcement = await createAnnouncement({
        title: parsed.data.title,
        summary: parsed.data.summary,
        bodyMarkdown: parsed.data.body_markdown,
        status: parsed.data.status,
        priority: parsed.data.priority,
        startsAt: parsed.data.starts_at ?? null,
        endsAt: parsed.data.ends_at ?? null,
        ctaLabel: parsed.data.cta_label ?? null,
        ctaHref: parsed.data.cta_href ?? null,
      });
      return reply.code(201).send(announcement);
    } catch (error) {
      if (isUniqueAnnouncementSlugConflict(error)) {
        return reply.code(409).send({ error: '公告 slug 已存在' });
      }
      throw error;
    }
  });

  // PATCH /api/admin/announcements/:id — 更新公告
  app.patch('/announcements/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = AnnouncementUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }

    const current = await getAdminAnnouncementById(id);
    if (!current) {
      return reply.code(404).send({ error: '公告不存在' });
    }
    const finalStateError = getAnnouncementStateError({
      starts_at:
        'starts_at' in parsed.data
          ? (parsed.data.starts_at ?? null)
          : current.starts_at,
      ends_at:
        'ends_at' in parsed.data
          ? (parsed.data.ends_at ?? null)
          : current.ends_at,
      cta_label:
        'cta_label' in parsed.data
          ? (parsed.data.cta_label ?? null)
          : current.cta_label,
      cta_href:
        'cta_href' in parsed.data
          ? (parsed.data.cta_href ?? null)
          : current.cta_href,
    });
    if (finalStateError) {
      return reply.code(400).send({ error: finalStateError });
    }

    try {
      const announcement = await updateAnnouncement(id, {
        title: parsed.data.title,
        summary: parsed.data.summary,
        bodyMarkdown: parsed.data.body_markdown,
        status: parsed.data.status,
        priority: parsed.data.priority,
        startsAt:
          'starts_at' in parsed.data
            ? (parsed.data.starts_at ?? null)
            : undefined,
        endsAt:
          'ends_at' in parsed.data ? (parsed.data.ends_at ?? null) : undefined,
        ctaLabel:
          'cta_label' in parsed.data
            ? (parsed.data.cta_label ?? null)
            : undefined,
        ctaHref:
          'cta_href' in parsed.data
            ? (parsed.data.cta_href ?? null)
            : undefined,
      });
      if (!announcement) {
        return reply.code(404).send({ error: '公告不存在' });
      }
      return announcement;
    } catch (error) {
      if (isUniqueAnnouncementSlugConflict(error)) {
        return reply.code(409).send({ error: '公告 slug 已存在' });
      }
      throw error;
    }
  });

  // DELETE /api/admin/announcements/:id — 删除草稿公告
  app.delete('/announcements/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const current = await getAdminAnnouncementById(id);
    if (!current) {
      return reply.code(404).send({ error: '公告不存在' });
    }
    const result = await deleteDraftAnnouncement(id);
    if (result.blockedStatus) {
      return reply
        .code(400)
        .send({ error: '已发布或已归档公告请使用归档，不允许硬删除' });
    }
    if (!result.deleted) {
      return reply.code(404).send({ error: '公告不存在' });
    }
    return { success: true };
  });

  // GET /api/admin/about-ledger — 关于页面公开收支流水
  app.get('/about-ledger', async () => {
    return { entries: await listPublicFinancialLedgerEntries() };
  });

  // POST /api/admin/about-ledger — 新增关于页面公开收支流水
  app.post('/about-ledger', async (request, reply) => {
    const parsed = PublicFinancialLedgerEntrySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    const entry = await createPublicFinancialLedgerEntry({
      entryType: parsed.data.entry_type,
      occurredAt: parsed.data.occurred_at,
      content: parsed.data.content,
      amountYuan: parsed.data.amount_yuan,
    });
    return reply.code(201).send(entry);
  });

  // PATCH /api/admin/about-ledger/:id — 更新关于页面公开收支流水
  app.patch('/about-ledger/:id', async (request, reply) => {
    const parsed = PublicFinancialLedgerEntrySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    const entry = await updatePublicFinancialLedgerEntry(
      (request.params as { id: string }).id,
      {
        entryType: parsed.data.entry_type,
        occurredAt: parsed.data.occurred_at,
        content: parsed.data.content,
        amountYuan: parsed.data.amount_yuan,
      },
    );
    if (!entry) {
      return reply.code(404).send({ error: '收支记录不存在' });
    }
    return entry;
  });

  // DELETE /api/admin/about-ledger/:id — 删除关于页面公开收支流水
  app.delete('/about-ledger/:id', async (request, reply) => {
    const deleted = await deletePublicFinancialLedgerEntry(
      (request.params as { id: string }).id,
    );
    if (!deleted) {
      return reply.code(404).send({ error: '收支记录不存在' });
    }
    return { success: true };
  });

  // POST /api/admin/system-config/providers — 新建官方模型
  app.post('/system-config/providers', async (request, reply) => {
    const parsed = OfficialModelCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    try {
      const provider = await createOfficialModel({
        modelKey: parsed.data.model_key,
        piApi: parsed.data.pi_api,
        displayName: parsed.data.display_name,
        description: parsed.data.description ?? '',
        enabled: parsed.data.enabled,
        priority: parsed.data.priority,
        baseUrl: parsed.data.base_url?.trim() || null,
        modelName: parsed.data.model_name,
        contextWindowTokens: toConfiguredContextWindowTokens(
          parsed.data.context_window_tokens,
        ),
        inputTokenPricePerMillionCoins:
          parsed.data.input_token_price_per_million_coins,
        outputTokenPricePerMillionCoins:
          parsed.data.output_token_price_per_million_coins,
        secretValue: parsed.data.api_key,
        authMode: parsed.data.auth_mode,
        actor: 'manager',
      });
      return provider;
    } catch (error) {
      if (isOfficialModelKeyConflict(error)) {
        return reply
          .code(409)
          .send({ error: '同名模型已存在，请换一个显示名称或模型名' });
      }
      throw error;
    }
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
        description: parsed.data.description,
        enabled: parsed.data.enabled,
        priority: parsed.data.priority,
        baseUrl: parsed.data.base_url?.trim() || null,
        modelName: parsed.data.model_name,
        secretValue: parsed.data.api_key?.trim() || null,
        authMode: parsed.data.auth_mode,
        contextWindowTokens: toConfiguredContextWindowTokens(
          parsed.data.context_window_tokens,
        ),
        inputTokenPricePerMillionCoins:
          parsed.data.input_token_price_per_million_coins,
        outputTokenPricePerMillionCoins:
          parsed.data.output_token_price_per_million_coins,
        actor: 'manager',
      });
      return provider;
    } catch (error) {
      if (isOfficialModelKeyConflict(error)) {
        return reply
          .code(409)
          .send({ error: '同名模型已存在，请换一个显示名称或模型名' });
      }
      return reply
        .code(404)
        .send({ error: error instanceof Error ? error.message : '更新失败' });
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
