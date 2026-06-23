import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import {
  createConfigAuditLog,
  createOfficialModelConfig,
  deleteOfficialModelConfig,
  deleteUserModelSelectionsByOfficialModelId,
  getOfficialModelConfig,
  getModelBillingConfig,
  getRuntimeConfig,
  getSystemSecret,
  getUserModelConfig,
  getUserModelSelection,
  listConfigAuditLogs,
  listOfficialModelConfigs,
  updateOfficialModelConfig,
  updateModelBillingConfig,
  updateRuntimeConfig,
  upsertSystemSecret,
  upsertUserModelConfig,
  upsertUserModelSelection,
} from '../../infrastructure/db.js';
import { getDefaultMaxOutputTokens } from '../../shared/output-token-policy.js';
import {
  normalizeConfiguredContextWindowTokens,
  resolveContextWindow,
} from '../../shared/model-context-window.js';
import type {
  ModelProviderType,
  OfficialModelConfig,
  PiThinkingLevel,
  UserModelConfig,
  UserModelSelection,
} from '../../shared/types.js';
import { PI_THINKING_LEVELS } from '../../shared/types.js';
import {
  MAX_SKILL_BUNDLE_FILE_LENGTH,
  MAX_SKILL_BUNDLE_FILES,
  MAX_SKILL_BUNDLE_TOTAL_LENGTH,
  MAX_SKILL_BUNDLE_ZIP_BYTES,
  MAX_USER_SKILLS,
  type SkillBundleLimitsDto,
} from '@fateclaw/contracts/skills';
import { getRuntimeEntitlementSnapshot } from '../billing/entitlements.js';

type RuntimeSecretSource = 'database' | 'missing';
export type ProviderAuthMode =
  | 'openai_api_key'
  | 'anthropic_api_key'
  | 'claude_code_oauth_token'
  | 'gemini_api_key';

export interface ResolvedProviderSecret {
  value: string | null;
  source: RuntimeSecretSource;
  authMode: ProviderAuthMode;
}

export type LlmRuntimeSource = 'custom' | 'official';
export type LlmBillingMode = 'none' | 'metered';
export const DEFAULT_CUSTOM_MODEL_PLATFORM_PRICE_PER_MILLION_COINS = 2;
export const DEFAULT_AGENT_CONCURRENCY_LIMIT = 10;
export const DEFAULT_LOCAL_AGENT_MAX_PROCESSES = 4;
export const DEFAULT_LOCAL_AGENT_IDLE_TTL_MS = 600_000;
export const DEFAULT_PI_THINKING_LEVEL: PiThinkingLevel = 'medium';
export const DEFAULT_PI_SESSION_INACTIVE_CLEANUP_DAYS = 30;
export const DEFAULT_PI_SESSION_ORPHAN_GRACE_DAYS = 30;
export const DEFAULT_SKILL_BUNDLE_MAX_FILES = MAX_SKILL_BUNDLE_FILES;
export const DEFAULT_SKILL_BUNDLE_MAX_FILE_CHARS = MAX_SKILL_BUNDLE_FILE_LENGTH;
export const DEFAULT_SKILL_BUNDLE_MAX_TOTAL_CHARS =
  MAX_SKILL_BUNDLE_TOTAL_LENGTH;
export const DEFAULT_SKILL_BUNDLE_MAX_ZIP_BYTES = MAX_SKILL_BUNDLE_ZIP_BYTES;
export const DEFAULT_USER_SKILL_MAX_COUNT = MAX_USER_SKILLS;
const CUSTOM_MODEL_MEMBERSHIP_REQUIRED_MESSAGE =
  '自配模型为会员专属，请开通会员后使用';

export type SkillBundleLimitsPolicy = SkillBundleLimitsDto;

export interface EffectiveLlmRuntimeConfig {
  source: LlmRuntimeSource;
  billingMode: LlmBillingMode;
  modelConfigId: string;
  providerKey: string;
  piApi: ModelProviderType;
  displayName: string;
  authMode: ProviderAuthMode;
  secret: string;
  secretSource: RuntimeSecretSource;
  baseUrl: string | null;
  model: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  thinkingLevel: PiThinkingLevel;
  inputTokenPricePerMillionCoins: number;
  outputTokenPricePerMillionCoins: number;
}

export type EffectiveAgentRuntimeConfig = EffectiveLlmRuntimeConfig;

export interface AdminOfficialModelView extends OfficialModelConfig {
  has_secret: boolean;
  secret_source: RuntimeSecretSource;
  auth_mode: ProviderAuthMode;
  context_window_tokens: number | null;
  description: string;
  api_key: string | null;
}

export interface UserModelSettingsOverview {
  custom:
    | (UserModelConfig & {
        has_secret: boolean;
        api_key: string | null;
        api_key_preview: string | null;
        api_key_fingerprint: string | null;
        auth_mode: ProviderAuthMode;
        context_window_tokens: number | null;
      })
    | null;
  selection: UserModelSelection | null;
  official_models: AdminOfficialModelView[];
  default_official_model_id: string | null;
  default_thinking_level: PiThinkingLevel;
  custom_model_membership_required: boolean;
  custom_model_membership_entitled: boolean;
  custom_model_platform_price_per_million_coins: number;
}

/** Pi session 健康维护策略，供后台任务和管理端文件审计复用。 */
export interface PiSessionHealthPolicy {
  enabled: boolean;
  inactiveCleanupDays: number;
  orphanGraceDays: number;
}

type ResolvedOfficialModelCandidate = {
  model: OfficialModelConfig;
  secret: ResolvedProviderSecret & { value: string };
};

function defaultAuthMode(piApi: ModelProviderType): ProviderAuthMode {
  if (piApi === 'google-generative-ai') return 'gemini_api_key';
  if (piApi === 'anthropic-messages') return 'anthropic_api_key';
  return 'openai_api_key';
}

function normalizeAuthMode(
  piApi: ModelProviderType,
  value: unknown,
): ProviderAuthMode {
  if (
    value === 'openai_api_key' ||
    value === 'anthropic_api_key' ||
    value === 'claude_code_oauth_token' ||
    value === 'gemini_api_key'
  ) {
    return value;
  }
  return defaultAuthMode(piApi);
}

function normalizeThinkingLevel(value: unknown): PiThinkingLevel {
  return PI_THINKING_LEVELS.includes(value as PiThinkingLevel)
    ? (value as PiThinkingLevel)
    : DEFAULT_PI_THINKING_LEVEL;
}

async function hasCustomModelMembershipEntitlement(
  userId: string,
): Promise<boolean> {
  const entitlement = await getRuntimeEntitlementSnapshot(userId);
  return entitlement.canUseCustomModel;
}

async function assertCustomModelMembershipEntitlement(
  userId: string,
): Promise<void> {
  // 自配模型现在作为会员项目控制，避免过期会员继续沿用历史选择。
  if (!(await hasCustomModelMembershipEntitlement(userId))) {
    throw new Error(CUSTOM_MODEL_MEMBERSHIP_REQUIRED_MESSAGE);
  }
}

function normalizeRuntimeDefaultThinkingLevel(value: unknown): PiThinkingLevel {
  return normalizeThinkingLevel(value ?? DEFAULT_PI_THINKING_LEVEL);
}

function normalizeModelContextWindowTokens(
  extraJson: Record<string, unknown> | null | undefined,
  label: string,
): number | null {
  return normalizeConfiguredContextWindowTokens(
    extraJson?.context_window_tokens,
    label,
  );
}

function withModelContextWindowTokens(
  extraJson: Record<string, unknown> | null | undefined,
  contextWindowTokens: number | null | undefined,
): Record<string, unknown> {
  const next = { ...(extraJson ?? {}) };
  if (contextWindowTokens === undefined) {
    return next;
  }
  if (contextWindowTokens === null) {
    delete next.context_window_tokens;
  } else {
    next.context_window_tokens = contextWindowTokens;
  }
  return next;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

function ipv4InCidr(ip: number, cidrBase: string, prefix: number): boolean {
  const base = ipv4ToNumber(cidrBase);
  if (base === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) === (base & mask);
}

function isBlockedIpv4(hostname: string): boolean {
  const ip = ipv4ToNumber(hostname);
  if (ip === null) return false;
  return [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ].some(([base, prefix]) => ipv4InCidr(ip, base as string, prefix as number));
}

function isBlockedIpv6(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname).toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) return true;
  const first = normalized.split(':').find((part) => part.length > 0);
  if (!first) return false;
  const firstHextet = Number.parseInt(first, 16);
  if (!Number.isFinite(firstHextet)) return false;
  return (
    (firstHextet & 0xfe00) === 0xfc00 ||
    (firstHextet & 0xffc0) === 0xfe80 ||
    (firstHextet & 0xff00) === 0xff00 ||
    normalized === '2001:db8' ||
    normalized.startsWith('2001:db8:')
  );
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname)
    .toLowerCase()
    .replace(/\.$/, '');
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return isBlockedIpv4(normalized);
  if (ipVersion === 6) return isBlockedIpv6(normalized);
  if (
    normalized === 'localhost' ||
    normalized === 'ip6-localhost' ||
    normalized === 'ip6-loopback' ||
    normalized === 'metadata' ||
    normalized === 'metadata.google.internal'
  ) {
    return true;
  }
  if (!normalized.includes('.')) return true;
  return ['.localhost', '.local', '.internal', '.lan', '.home', '.corp'].some(
    (suffix) => normalized.endsWith(suffix),
  );
}

/**
 * 校验并规范化用户自配模型 Base URL。
 *
 * @param value 用户提交或数据库中保存的 Base URL。
 * @returns 可安全传给供应商 SDK 的 URL；空值表示使用协议默认地址。
 * @throws 当 URL 协议、主机或凭据存在 SSRF 风险时抛出面向用户的错误。
 */
export function normalizeCustomModelBaseUrl(
  value: string | null | undefined,
): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (err) {
    throw new Error('Base URL 格式不正确', { cause: err });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Base URL 仅支持 http 或 https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Base URL 不允许包含用户名或密码');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Base URL 不允许包含查询参数或片段');
  }
  if (!parsed.hostname || isBlockedHostname(parsed.hostname)) {
    throw new Error('Base URL 不能指向本机、内网、链路本地或云 metadata 地址');
  }
  return raw;
}

function apiKeyPreview(secret: string | null | undefined): string | null {
  const normalized = secret?.trim();
  if (!normalized) return null;
  return normalized.length <= 4 ? '已配置' : `...${normalized.slice(-4)}`;
}

function apiKeyFingerprint(secret: string | null | undefined): string | null {
  const normalized = secret?.trim();
  if (!normalized) return null;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/** 从扩展配置里读取供用户理解模型用途的说明文案。 */
function normalizeModelDescription(
  extraJson: Record<string, unknown> | null | undefined,
): string {
  const value = extraJson?.description;
  return typeof value === 'string' ? value.trim() : '';
}

/** 将官方模型说明写入扩展配置；空字符串表示清除说明。 */
function withModelDescription(
  extraJson: Record<string, unknown> | null | undefined,
  description: string | undefined,
): Record<string, unknown> {
  const next = { ...(extraJson ?? {}) };
  if (description === undefined) {
    return next;
  }
  const value = description.trim();
  if (value) {
    next.description = value;
  } else {
    delete next.description;
  }
  return next;
}

function normalizePolicyDays(value: unknown, fallback: number): number {
  const numeric =
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(3650, Math.max(1, Math.floor(numeric)));
}

function normalizePolicyInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const numeric =
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function runtimeToSkillBundleLimits(runtime: {
  skill_bundle_max_files?: number;
  skill_bundle_max_file_chars?: number;
  skill_bundle_max_total_chars?: number;
  skill_bundle_max_zip_bytes?: number;
}): SkillBundleLimitsPolicy {
  const maxFileChars = normalizePolicyInteger(
    runtime.skill_bundle_max_file_chars,
    DEFAULT_SKILL_BUNDLE_MAX_FILE_CHARS,
    1,
    2_000_000,
  );
  return {
    max_files: normalizePolicyInteger(
      runtime.skill_bundle_max_files,
      DEFAULT_SKILL_BUNDLE_MAX_FILES,
      1,
      500,
    ),
    max_file_chars: maxFileChars,
    max_total_chars: normalizePolicyInteger(
      runtime.skill_bundle_max_total_chars,
      DEFAULT_SKILL_BUNDLE_MAX_TOTAL_CHARS,
      maxFileChars,
      10_000_000,
    ),
    max_zip_bytes: normalizePolicyInteger(
      runtime.skill_bundle_max_zip_bytes,
      DEFAULT_SKILL_BUNDLE_MAX_ZIP_BYTES,
      1024,
      100 * 1024 * 1024,
    ),
  };
}

async function resolveSecret(input: {
  secretKey: string | null;
  piApi: ModelProviderType;
  extraJson?: Record<string, unknown> | null;
}): Promise<ResolvedProviderSecret> {
  const authMode = normalizeAuthMode(input.piApi, input.extraJson?.auth_mode);
  if (!input.secretKey) {
    return { value: null, source: 'missing', authMode };
  }
  const secret = await getSystemSecret(input.secretKey);
  if (!secret?.secret_value) {
    return { value: null, source: 'missing', authMode };
  }
  return { value: secret.secret_value, source: 'database', authMode };
}

function requireModelName(modelName: string, label: string): string {
  const model = modelName.trim();
  if (!model) {
    throw new Error(`${label} 未配置模型名`);
  }
  return model;
}

function officialModelTotalPriceCoins(model: OfficialModelConfig): number {
  return (
    model.input_token_price_per_million_coins +
    model.output_token_price_per_million_coins
  );
}

function buildOfficialRuntime(
  model: OfficialModelConfig,
  secret: ResolvedProviderSecret & { value: string },
  thinkingLevel: PiThinkingLevel = DEFAULT_PI_THINKING_LEVEL,
): EffectiveLlmRuntimeConfig {
  const modelName = requireModelName(model.model_name, model.display_name);
  const contextWindowTokens = resolveContextWindow({
    model: modelName,
    configured: normalizeModelContextWindowTokens(
      model.extra_json,
      model.display_name,
    ),
  });
  return {
    source: 'official',
    billingMode: 'metered',
    modelConfigId: model.id,
    providerKey: model.model_key,
    piApi: model.pi_api,
    displayName: model.display_name,
    authMode: secret.authMode,
    secret: secret.value,
    secretSource: secret.source,
    baseUrl: model.base_url,
    model: modelName,
    contextWindowTokens,
    // 输出上限不再从后台配置读取，避免把“上下文窗口”误传成供应商 API 的 max_tokens。
    maxOutputTokens: getDefaultMaxOutputTokens(modelName, contextWindowTokens),
    thinkingLevel,
    inputTokenPricePerMillionCoins: model.input_token_price_per_million_coins,
    outputTokenPricePerMillionCoins: model.output_token_price_per_million_coins,
  };
}

async function resolveUsableOfficialModelCandidate(
  model: OfficialModelConfig,
): Promise<ResolvedOfficialModelCandidate | null> {
  if (!model.enabled || !model.model_name.trim()) {
    return null;
  }

  const secret = await resolveSecret({
    secretKey: model.api_key_secret_key,
    piApi: model.pi_api,
    extraJson: model.extra_json,
  });
  if (!secret.value) {
    return null;
  }

  return {
    model,
    secret: { ...secret, value: secret.value },
  };
}

async function resolveLowestPricedOfficialRuntime(
  thinkingLevel: PiThinkingLevel = DEFAULT_PI_THINKING_LEVEL,
): Promise<EffectiveLlmRuntimeConfig | null> {
  const models = await listOfficialModelConfigs();
  let lowest: ResolvedOfficialModelCandidate | null = null;

  for (const model of models) {
    const candidate = await resolveUsableOfficialModelCandidate(model);
    if (!candidate) {
      continue;
    }
    if (
      !lowest ||
      officialModelTotalPriceCoins(candidate.model) <
        officialModelTotalPriceCoins(lowest.model)
    ) {
      lowest = candidate;
    }
  }

  return lowest
    ? buildOfficialRuntime(lowest.model, lowest.secret, thinkingLevel)
    : null;
}

async function resolveConfiguredDefaultOfficialRuntime(
  thinkingLevel: PiThinkingLevel = DEFAULT_PI_THINKING_LEVEL,
): Promise<EffectiveLlmRuntimeConfig | null> {
  const runtime = await getRuntimeConfig();
  const defaultOfficialModelId = runtime.default_official_model_id?.trim();
  if (!defaultOfficialModelId) return null;

  const model = await getOfficialModelConfig(defaultOfficialModelId);
  if (!model) return null;

  const candidate = await resolveUsableOfficialModelCandidate(model);
  return candidate
    ? buildOfficialRuntime(candidate.model, candidate.secret, thinkingLevel)
    : null;
}

async function resolveFallbackOfficialRuntime(
  thinkingLevel: PiThinkingLevel = DEFAULT_PI_THINKING_LEVEL,
): Promise<EffectiveLlmRuntimeConfig | null> {
  return (
    (await resolveConfiguredDefaultOfficialRuntime(thinkingLevel)) ??
    (await resolveLowestPricedOfficialRuntime(thinkingLevel))
  );
}

async function resolveOfficialRuntime(
  selection: UserModelSelection,
): Promise<EffectiveLlmRuntimeConfig> {
  if (!selection.official_model_id) {
    throw new Error('当前选择的官方模型无效，请重新选择模型');
  }
  const model = await getOfficialModelConfig(selection.official_model_id);
  if (!model || !model.enabled) {
    throw new Error('当前选择的官方模型不可用，请重新选择模型');
  }
  const secret = await resolveSecret({
    secretKey: model.api_key_secret_key,
    piApi: model.pi_api,
    extraJson: model.extra_json,
  });
  if (!secret.value) {
    throw new Error('当前选择的官方模型未配置密钥，请联系管理员');
  }
  return buildOfficialRuntime(
    model,
    {
      ...secret,
      value: secret.value,
    },
    normalizeThinkingLevel(selection.thinking_level),
  );
}

async function resolveCustomRuntime(
  userId: string,
  thinkingLevel: PiThinkingLevel = DEFAULT_PI_THINKING_LEVEL,
): Promise<EffectiveLlmRuntimeConfig> {
  await assertCustomModelMembershipEntitlement(userId);
  const config = await getUserModelConfig(userId);
  if (!config) {
    throw new Error('当前选择了自配模型，但尚未保存模型配置');
  }
  const secret = await resolveSecret({
    secretKey: config.api_key_secret_key,
    piApi: config.pi_api,
    extraJson: config.extra_json,
  });
  if (!secret.value) {
    throw new Error('当前选择了自配模型，但尚未保存 API Key');
  }
  const modelName = requireModelName(config.model_name, '自配模型');
  const contextWindowTokens = resolveContextWindow({
    model: modelName,
    configured: normalizeModelContextWindowTokens(
      config.extra_json,
      '自配模型',
    ),
  });
  const modelBilling = await getModelBillingConfig();
  // 注意：BYOK（source==='custom'）在 plans.ts 结算时被短路、直接返回 0 费用，
  // 故此平台单价虽写入 runtime 快照却永不参与扣费（配置存在但不生效）。
  // 保留字段仅为未来对 BYOK 抽取平台手续费的预留，admin 仍可配置但当前无实际效果。
  const platformPriceCoins =
    modelBilling.custom_model_platform_price_per_million_coins;
  return {
    source: 'custom',
    billingMode: 'metered',
    modelConfigId: userId,
    providerKey: `custom:${userId}`,
    piApi: config.pi_api,
    displayName: '自配模型',
    authMode: secret.authMode,
    secret: secret.value,
    secretSource: secret.source,
    baseUrl: normalizeCustomModelBaseUrl(config.base_url),
    model: modelName,
    contextWindowTokens,
    maxOutputTokens: getDefaultMaxOutputTokens(modelName, contextWindowTokens),
    thinkingLevel,
    inputTokenPricePerMillionCoins: platformPriceCoins,
    outputTokenPricePerMillionCoins: platformPriceCoins,
  };
}

export function invalidateSystemConfigCache(): void {
  // 保留导出兼容测试和调用点。用户级模型选择不做全局 runtime 缓存。
}

export async function resolveUserLlmRuntime(
  userId: string,
): Promise<EffectiveLlmRuntimeConfig> {
  const selection = await getUserModelSelection(userId);
  const runtimeDefaultThinkingLevel = selection
    ? DEFAULT_PI_THINKING_LEVEL
    : normalizeRuntimeDefaultThinkingLevel(
        (await getRuntimeConfig()).default_thinking_level,
      );
  if (!selection) {
    const fallbackRuntime = await resolveFallbackOfficialRuntime(
      runtimeDefaultThinkingLevel,
    );
    if (fallbackRuntime) {
      return fallbackRuntime;
    }
    throw new Error('未选择模型，请先在模型设置中选择官方模型或自配模型');
  }
  if (selection.source === 'custom') {
    const thinkingLevel = normalizeThinkingLevel(selection.thinking_level);
    try {
      return await resolveCustomRuntime(userId, thinkingLevel);
    } catch (error) {
      const fallbackRuntime =
        await resolveFallbackOfficialRuntime(thinkingLevel);
      if (fallbackRuntime) {
        return fallbackRuntime;
      }
      throw error;
    }
  }
  try {
    return await resolveOfficialRuntime(selection);
  } catch (error) {
    const fallbackRuntime = await resolveFallbackOfficialRuntime(
      normalizeThinkingLevel(selection.thinking_level),
    );
    if (fallbackRuntime) {
      return fallbackRuntime;
    }
    throw error;
  }
}

export async function getEffectiveAgentRuntimeConfig(
  userId: string,
): Promise<EffectiveAgentRuntimeConfig> {
  return resolveUserLlmRuntime(userId);
}

export async function getEffectiveAgentModel(userId: string): Promise<string> {
  return (await resolveUserLlmRuntime(userId)).model;
}

export async function listOfficialModelViews(options?: {
  includeSecretValue?: boolean;
}): Promise<AdminOfficialModelView[]> {
  const models = await listOfficialModelConfigs();
  return Promise.all(
    models.map(async (model) => {
      const secret = await resolveSecret({
        secretKey: model.api_key_secret_key,
        piApi: model.pi_api,
        extraJson: model.extra_json,
      });
      return {
        ...model,
        has_secret: Boolean(secret.value),
        secret_source: secret.source,
        auth_mode: secret.authMode,
        api_key: options?.includeSecretValue ? secret.value : null,
        context_window_tokens: normalizeModelContextWindowTokens(
          model.extra_json,
          model.display_name,
        ),
        description: normalizeModelDescription(model.extra_json),
      };
    }),
  );
}

export async function getSystemConfigOverview(): Promise<{
  official_models: AdminOfficialModelView[];
  providers: AdminOfficialModelView[];
  model_billing: {
    custom_model_platform_price_per_million_coins: number;
    updated_at: string;
  };
  runtime: {
    agent_concurrency_limit: number;
    local_agent_max_processes: number;
    local_agent_idle_ttl_ms: number;
    default_official_model_id: string | null;
    default_thinking_level: PiThinkingLevel;
    pi_session_health_enabled: boolean;
    pi_session_inactive_cleanup_days: number;
    pi_session_orphan_grace_days: number;
    user_skill_max_count: number;
    skill_bundle_max_files: number;
    skill_bundle_max_file_chars: number;
    skill_bundle_max_total_chars: number;
    skill_bundle_max_zip_bytes: number;
    updated_at: string;
  };
  audit_logs: Awaited<ReturnType<typeof listConfigAuditLogs>>;
}> {
  const [models, auditLogs, modelBilling, runtime] = await Promise.all([
    listOfficialModelViews({ includeSecretValue: true }),
    listConfigAuditLogs(50),
    getModelBillingConfig(),
    getRuntimeConfig(),
  ]);
  const skillBundleLimits = runtimeToSkillBundleLimits(runtime);
  return {
    official_models: models,
    providers: models,
    model_billing: {
      custom_model_platform_price_per_million_coins:
        modelBilling.custom_model_platform_price_per_million_coins,
      updated_at: modelBilling.updated_at,
    },
    runtime: {
      agent_concurrency_limit: runtime.agent_concurrency_limit,
      local_agent_max_processes: runtime.local_agent_max_processes,
      local_agent_idle_ttl_ms: runtime.local_agent_idle_ttl_ms,
      default_official_model_id: runtime.default_official_model_id ?? null,
      default_thinking_level: normalizeRuntimeDefaultThinkingLevel(
        runtime.default_thinking_level,
      ),
      pi_session_health_enabled: runtime.pi_session_health_enabled,
      pi_session_inactive_cleanup_days:
        runtime.pi_session_inactive_cleanup_days,
      pi_session_orphan_grace_days: runtime.pi_session_orphan_grace_days,
      user_skill_max_count: normalizePolicyInteger(
        runtime.user_skill_max_count,
        DEFAULT_USER_SKILL_MAX_COUNT,
        1,
        500,
      ),
      skill_bundle_max_files: skillBundleLimits.max_files,
      skill_bundle_max_file_chars: skillBundleLimits.max_file_chars,
      skill_bundle_max_total_chars: skillBundleLimits.max_total_chars,
      skill_bundle_max_zip_bytes: skillBundleLimits.max_zip_bytes,
      updated_at: runtime.updated_at,
    },
    audit_logs: auditLogs,
  };
}

/**
 * 更新自配模型平台 Token 服务费。
 */
export async function updateModelBillingSettings(args: {
  customModelPlatformPricePerMillionCoins: number;
  actor?: string;
}): Promise<{
  custom_model_platform_price_per_million_coins: number;
  updated_at: string;
}> {
  const actor = args.actor ?? 'admin';
  const before = await getModelBillingConfig();
  const updated = await updateModelBillingConfig({
    customModelPlatformPricePerMillionCoins:
      args.customModelPlatformPricePerMillionCoins,
  });
  await createConfigAuditLog({
    id: `cfg-audit-${randomUUID()}`,
    actorUserId: actor,
    action: 'model_billing.updated',
    targetType: 'model_billing',
    targetKey: updated.id,
    before,
    after: updated,
  });
  return {
    custom_model_platform_price_per_million_coins:
      updated.custom_model_platform_price_per_million_coins,
    updated_at: updated.updated_at,
  };
}

/**
 * 读取全站 Agent 并发槽位上限。
 */
export async function getAgentConcurrencyLimit(): Promise<number> {
  const runtime = await getRuntimeConfig();
  return Math.max(
    1,
    Math.floor(
      runtime.agent_concurrency_limit || DEFAULT_AGENT_CONCURRENCY_LIMIT,
    ),
  );
}

/**
 * 读取本地 agent-runtime 常驻进程策略。
 */
export async function getLocalAgentRuntimePolicy(): Promise<{
  maxProcesses: number;
  idleTtlMs: number;
}> {
  const runtime = await getRuntimeConfig();
  return {
    maxProcesses: Math.min(
      100,
      Math.max(
        1,
        Math.floor(
          runtime.local_agent_max_processes ||
            DEFAULT_LOCAL_AGENT_MAX_PROCESSES,
        ),
      ),
    ),
    idleTtlMs: Math.min(
      86_400_000,
      Math.max(
        30_000,
        Math.floor(
          runtime.local_agent_idle_ttl_ms || DEFAULT_LOCAL_AGENT_IDLE_TTL_MS,
        ),
      ),
    ),
  };
}

/**
 * 读取 Pi session 健康维护策略。
 *
 * @returns 后台任务和孤儿文件扫描共用的归一化策略。
 * @remarks 这里只读取 DB 配置，不引入 Pi session 相关环境变量。
 */
export async function getPiSessionHealthPolicy(): Promise<PiSessionHealthPolicy> {
  const runtime = await getRuntimeConfig();
  return {
    enabled: Boolean(runtime.pi_session_health_enabled),
    inactiveCleanupDays: normalizePolicyDays(
      runtime.pi_session_inactive_cleanup_days,
      DEFAULT_PI_SESSION_INACTIVE_CLEANUP_DAYS,
    ),
    orphanGraceDays: normalizePolicyDays(
      runtime.pi_session_orphan_grace_days,
      DEFAULT_PI_SESSION_ORPHAN_GRACE_DAYS,
    ),
  };
}

/**
 * 读取当前生效的用户 Text Skill Bundle 文件限制。
 *
 * @returns 普通用户导入、编辑和服务端写入校验共用的限制。
 */
export async function getSkillBundleLimitsPolicy(): Promise<SkillBundleLimitsPolicy> {
  return runtimeToSkillBundleLimits(await getRuntimeConfig());
}

/**
 * 读取用户自定义 Skill 数量上限，创建 Skill 时按后台配置动态限制。
 */
export async function getUserSkillLimitPolicy(): Promise<number> {
  const runtime = await getRuntimeConfig();
  return normalizePolicyInteger(
    runtime.user_skill_max_count,
    DEFAULT_USER_SKILL_MAX_COUNT,
    1,
    500,
  );
}

/**
 * 更新全站 Agent 运行时策略。
 */
export async function updateRuntimeSettings(args: {
  agentConcurrencyLimit: number;
  localAgentMaxProcesses?: number;
  localAgentIdleTtlMs?: number;
  defaultOfficialModelId?: string | null;
  defaultThinkingLevel?: PiThinkingLevel;
  piSessionHealthEnabled?: boolean;
  piSessionInactiveCleanupDays?: number;
  piSessionOrphanGraceDays?: number;
  userSkillMaxCount?: number;
  skillBundleMaxFiles?: number;
  skillBundleMaxFileChars?: number;
  skillBundleMaxTotalChars?: number;
  skillBundleMaxZipBytes?: number;
  actor?: string;
}): Promise<{
  agent_concurrency_limit: number;
  local_agent_max_processes: number;
  local_agent_idle_ttl_ms: number;
  default_official_model_id: string | null;
  default_thinking_level: PiThinkingLevel;
  pi_session_health_enabled: boolean;
  pi_session_inactive_cleanup_days: number;
  pi_session_orphan_grace_days: number;
  user_skill_max_count: number;
  skill_bundle_max_files: number;
  skill_bundle_max_file_chars: number;
  skill_bundle_max_total_chars: number;
  skill_bundle_max_zip_bytes: number;
  updated_at: string;
}> {
  const actor = args.actor ?? 'admin';
  const before = await getRuntimeConfig();
  if (args.defaultOfficialModelId) {
    const defaultModel = await getOfficialModelConfig(
      args.defaultOfficialModelId,
    );
    if (!defaultModel) {
      throw new Error('默认官方模型不存在');
    }
  }
  const updated = await updateRuntimeConfig({
    agentConcurrencyLimit: args.agentConcurrencyLimit,
    localAgentMaxProcesses: args.localAgentMaxProcesses,
    localAgentIdleTtlMs: args.localAgentIdleTtlMs,
    defaultOfficialModelId: args.defaultOfficialModelId,
    defaultThinkingLevel: args.defaultThinkingLevel,
    piSessionHealthEnabled: args.piSessionHealthEnabled,
    piSessionInactiveCleanupDays: args.piSessionInactiveCleanupDays,
    piSessionOrphanGraceDays: args.piSessionOrphanGraceDays,
    userSkillMaxCount: args.userSkillMaxCount,
    skillBundleMaxFiles: args.skillBundleMaxFiles,
    skillBundleMaxFileChars: args.skillBundleMaxFileChars,
    skillBundleMaxTotalChars: args.skillBundleMaxTotalChars,
    skillBundleMaxZipBytes: args.skillBundleMaxZipBytes,
  });
  await createConfigAuditLog({
    id: `cfg-audit-${randomUUID()}`,
    actorUserId: actor,
    action: 'runtime.updated',
    targetType: 'runtime',
    targetKey: updated.id,
    before,
    after: updated,
  });
  const skillBundleLimits = runtimeToSkillBundleLimits(updated);
  const userSkillMaxCount = normalizePolicyInteger(
    updated.user_skill_max_count,
    DEFAULT_USER_SKILL_MAX_COUNT,
    1,
    500,
  );
  return {
    agent_concurrency_limit: updated.agent_concurrency_limit,
    local_agent_max_processes: updated.local_agent_max_processes,
    local_agent_idle_ttl_ms: updated.local_agent_idle_ttl_ms,
    default_official_model_id: updated.default_official_model_id ?? null,
    default_thinking_level: normalizeRuntimeDefaultThinkingLevel(
      updated.default_thinking_level,
    ),
    pi_session_health_enabled: updated.pi_session_health_enabled,
    pi_session_inactive_cleanup_days: updated.pi_session_inactive_cleanup_days,
    pi_session_orphan_grace_days: updated.pi_session_orphan_grace_days,
    user_skill_max_count: userSkillMaxCount,
    skill_bundle_max_files: skillBundleLimits.max_files,
    skill_bundle_max_file_chars: skillBundleLimits.max_file_chars,
    skill_bundle_max_total_chars: skillBundleLimits.max_total_chars,
    skill_bundle_max_zip_bytes: skillBundleLimits.max_zip_bytes,
    updated_at: updated.updated_at,
  };
}

export async function createOfficialModel(args: {
  modelKey: string;
  piApi: ModelProviderType;
  displayName: string;
  enabled?: boolean;
  priority?: number;
  baseUrl?: string | null;
  modelName: string;
  inputTokenPricePerMillionCoins?: number;
  outputTokenPricePerMillionCoins?: number;
  contextWindowTokens?: number | null;
  description?: string;
  secretValue?: string;
  authMode?: ProviderAuthMode;
  actor?: string;
}): Promise<OfficialModelConfig> {
  const actor = args.actor ?? 'admin';
  const id = `official-model-${randomUUID()}`;
  const secretKey = args.secretValue ? `official-model:${id}:secret` : null;
  if (args.secretValue && secretKey) {
    await upsertSystemSecret({
      key: secretKey,
      secretValue: args.secretValue,
      updatedBy: actor,
    });
  }
  const extraJson = withModelDescription(
    withModelContextWindowTokens(
      args.authMode || args.secretValue
        ? { auth_mode: args.authMode ?? defaultAuthMode(args.piApi) }
        : {},
      args.contextWindowTokens,
    ),
    args.description,
  );
  const created = await createOfficialModelConfig({
    id,
    modelKey: args.modelKey,
    piApi: args.piApi,
    displayName: args.displayName,
    enabled: args.enabled ?? true,
    priority: args.priority ?? 0,
    baseUrl: args.baseUrl ?? null,
    modelName: args.modelName,
    apiKeySecretKey: secretKey,
    inputTokenPricePerMillionCoins: args.inputTokenPricePerMillionCoins ?? 0,
    outputTokenPricePerMillionCoins: args.outputTokenPricePerMillionCoins ?? 0,
    extraJson,
  });
  await createConfigAuditLog({
    id: `cfg-audit-${randomUUID()}`,
    actorUserId: actor,
    action: 'official_model.created',
    targetType: 'official_model',
    targetKey: created.id,
    after: created,
  });
  return created;
}

export async function updateOfficialModel(args: {
  id: string;
  modelKey: string;
  piApi: ModelProviderType;
  displayName: string;
  enabled: boolean;
  priority: number;
  baseUrl?: string | null;
  modelName: string;
  secretValue?: string | null;
  authMode?: ProviderAuthMode;
  inputTokenPricePerMillionCoins: number;
  outputTokenPricePerMillionCoins: number;
  contextWindowTokens?: number | null;
  description?: string;
  actor?: string;
}): Promise<OfficialModelConfig> {
  const actor = args.actor ?? 'admin';
  const before = await getOfficialModelConfig(args.id);
  if (!before) {
    throw new Error('官方模型不存在');
  }
  const secretValue = args.secretValue?.trim();
  const secretKey = secretValue
    ? before.api_key_secret_key || `official-model:${before.id}:secret`
    : before.api_key_secret_key;
  if (secretValue && secretKey) {
    await upsertSystemSecret({
      key: secretKey,
      secretValue,
      updatedBy: actor,
    });
  }
  const updated = await updateOfficialModelConfig({
    id: args.id,
    modelKey: args.modelKey,
    piApi: args.piApi,
    displayName: args.displayName,
    enabled: args.enabled,
    priority: args.priority,
    baseUrl: args.baseUrl ?? null,
    modelName: args.modelName,
    apiKeySecretKey: secretKey,
    inputTokenPricePerMillionCoins: args.inputTokenPricePerMillionCoins,
    outputTokenPricePerMillionCoins: args.outputTokenPricePerMillionCoins,
    extraJson: withModelDescription(
      withModelContextWindowTokens(
        secretValue || args.authMode
          ? {
              ...(before.extra_json ?? {}),
              auth_mode: args.authMode ?? defaultAuthMode(args.piApi),
            }
          : before.extra_json,
        args.contextWindowTokens,
      ),
      args.description,
    ),
  });
  if (!updated) {
    throw new Error('官方模型更新失败');
  }
  await createConfigAuditLog({
    id: `cfg-audit-${randomUUID()}`,
    actorUserId: actor,
    action: 'official_model.updated',
    targetType: 'official_model',
    targetKey: updated.id,
    before,
    after: updated,
  });
  return updated;
}

export async function removeOfficialModel(
  id: string,
  actor = 'admin',
): Promise<void> {
  const target = await getOfficialModelConfig(id);
  if (!target) {
    throw new Error('官方模型不存在');
  }
  const deletedSelectionCount =
    await deleteUserModelSelectionsByOfficialModelId(id);
  await deleteOfficialModelConfig(id);
  await createConfigAuditLog({
    id: `cfg-audit-${randomUUID()}`,
    actorUserId: actor,
    action: 'official_model.deleted',
    targetType: 'official_model',
    targetKey: id,
    before: target,
    after: { deleted_selection_count: deletedSelectionCount },
  });
}

export async function getUserModelSettingsOverview(
  userId: string,
): Promise<UserModelSettingsOverview> {
  const [
    custom,
    selection,
    officialModels,
    modelBilling,
    runtime,
    entitlement,
  ] = await Promise.all([
    getUserModelConfig(userId),
    getUserModelSelection(userId),
    listOfficialModelViews(),
    getModelBillingConfig(),
    getRuntimeConfig(),
    getRuntimeEntitlementSnapshot(userId),
  ]);
  const customSecret = custom
    ? await resolveSecret({
        secretKey: custom.api_key_secret_key,
        piApi: custom.pi_api,
        extraJson: custom.extra_json,
      })
    : null;
  return {
    custom: custom
      ? {
          ...custom,
          has_secret: Boolean(customSecret?.value),
          api_key: null,
          api_key_preview: apiKeyPreview(customSecret?.value),
          api_key_fingerprint: apiKeyFingerprint(customSecret?.value),
          auth_mode: customSecret?.authMode ?? defaultAuthMode(custom.pi_api),
          context_window_tokens: normalizeModelContextWindowTokens(
            custom.extra_json,
            '自配模型',
          ),
        }
      : null,
    selection: selection
      ? {
          ...selection,
          thinking_level: normalizeThinkingLevel(selection.thinking_level),
        }
      : null,
    official_models: officialModels,
    default_official_model_id: runtime.default_official_model_id ?? null,
    default_thinking_level: normalizeRuntimeDefaultThinkingLevel(
      runtime.default_thinking_level,
    ),
    custom_model_membership_required: true,
    custom_model_membership_entitled: entitlement.canUseCustomModel,
    custom_model_platform_price_per_million_coins:
      modelBilling.custom_model_platform_price_per_million_coins,
  };
}

export async function saveUserCustomModelConfig(args: {
  userId: string;
  piApi: ModelProviderType;
  baseUrl?: string | null;
  modelName: string;
  authMode?: ProviderAuthMode;
  contextWindowTokens?: number | null;
  secretValue?: string;
}): Promise<UserModelConfig> {
  await assertCustomModelMembershipEntitlement(args.userId);
  const existing = await getUserModelConfig(args.userId);
  const baseUrl = normalizeCustomModelBaseUrl(args.baseUrl);
  const secretKey = args.secretValue
    ? (existing?.api_key_secret_key ?? `user-model:${args.userId}:secret`)
    : (existing?.api_key_secret_key ?? null);
  if (args.secretValue && secretKey) {
    await upsertSystemSecret({
      key: secretKey,
      secretValue: args.secretValue,
      updatedBy: args.userId,
    });
  }
  return upsertUserModelConfig({
    userId: args.userId,
    piApi: args.piApi,
    baseUrl,
    modelName: args.modelName,
    apiKeySecretKey: secretKey,
    extraJson: {
      ...withModelContextWindowTokens(
        existing?.extra_json,
        args.contextWindowTokens,
      ),
      auth_mode: args.authMode ?? defaultAuthMode(args.piApi),
    },
  });
}

export async function setUserModelSelection(args: {
  userId: string;
  source: UserModelSelection['source'];
  officialModelId?: string | null;
  thinkingLevel?: PiThinkingLevel;
}): Promise<UserModelSelection> {
  const existing = await getUserModelSelection(args.userId);
  const runtime = await getRuntimeConfig();
  const thinkingLevel = normalizeThinkingLevel(
    args.thinkingLevel ??
      existing?.thinking_level ??
      runtime.default_thinking_level,
  );
  if (args.source === 'official') {
    if (!args.officialModelId) {
      throw new Error('请选择官方模型');
    }
    const model = await getOfficialModelConfig(args.officialModelId);
    if (!model || !model.enabled) {
      throw new Error('选择的官方模型不可用');
    }
  } else {
    await assertCustomModelMembershipEntitlement(args.userId);
  }
  return upsertUserModelSelection({
    userId: args.userId,
    source: args.source,
    officialModelId:
      args.source === 'official' ? (args.officialModelId ?? null) : null,
    thinkingLevel,
  });
}
