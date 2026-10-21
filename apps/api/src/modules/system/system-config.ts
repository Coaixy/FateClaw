import {
  getPlatformModelSettings,
  getPlatformModelRuntimeSettings,
  savePlatformModelConfig,
  getRuntimeConfig,
} from '#infrastructure/db';
import {
  ModelConfigurationError,
  type PlatformModelSettings,
  type PlatformModelRuntimeSettings,
} from '#infrastructure/repositories/config-repository';
import { getDefaultMaxOutputTokens } from '#shared/output-token-policy';
import {
  normalizeConfiguredContextWindowTokens,
  resolveContextWindow,
} from '#shared/model-context-window';
import type {
  ModelProviderType,
  OfficialModelConfig,
  PiThinkingLevel,
} from '#shared/types';
import { PI_THINKING_LEVELS } from '#shared/types';
import type {
  AdminModelSettingsOverviewDto,
  AdminModelSettingsUpdateDto,
  RuntimeModelPoolNode,
  ModelAuthModeDto,
  ModelSettingsOverviewDto,
  OfficialModelDto,
  ModelPoolKey,
  BenefitPolicyDto,
} from '@fateclaw/contracts/model-settings';
import {
  getBenefitAllowance,
  getBenefitSupply,
  getPreferredModelPool,
} from '#infrastructure/repositories/benefit-repository';
import { getRuntimeEntitlementSnapshot } from '#modules/billing/entitlements';
import { NON_MEMBER_PRICE_MULTIPLIER } from '#modules/billing/plans';
import type { SkillBundleLimitsDto } from '@fateclaw/contracts/skills';

type RuntimeSecretSource = 'database' | 'missing';
export class ModelUnavailableError extends Error {
  readonly code = 'MODEL_UNAVAILABLE';
}
export type ProviderAuthMode = ModelAuthModeDto;
// Historical billing snapshots can still contain custom model requests.
export type LlmRuntimeSource = 'custom' | 'official';
export type LlmBillingMode = 'none' | 'metered';
export const DEFAULT_PI_THINKING_LEVEL: PiThinkingLevel = 'medium';
export type SkillBundleLimitsPolicy = SkillBundleLimitsDto;

export interface EffectiveLlmRuntimeConfig {
  poolKey?: ModelPoolKey;
  poolRevision?: number;
  benefitPolicy?: BenefitPolicyDto;
  benefitRequestId?: string;
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
  poolNodes?: RuntimeModelPoolNode[];
}

export interface PiSessionHealthPolicy {
  enabled: boolean;
  inactiveCleanupDays: number;
  orphanGraceDays: number;
}

function normalizeThinkingLevel(value: unknown): PiThinkingLevel {
  return PI_THINKING_LEVELS.includes(value as PiThinkingLevel)
    ? (value as PiThinkingLevel)
    : DEFAULT_PI_THINKING_LEVEL;
}

function normalizeAuthMode(model: OfficialModelConfig): ProviderAuthMode {
  const value = model.extra_json?.auth_mode;
  if (model.pi_api === 'anthropic-messages') {
    return value === 'claude_code_oauth_token' ? value : 'anthropic_api_key';
  }
  return model.pi_api === 'google-generative-ai'
    ? 'gemini_api_key'
    : 'openai_api_key';
}

function modelContextWindow(model: OfficialModelConfig): number | null {
  return normalizeConfiguredContextWindowTokens(
    model.extra_json?.context_window_tokens,
    model.display_name,
  );
}

function configuredNodes(settings: PlatformModelSettings) {
  if (settings.pool.enabled === false) return [];
  return settings.nodes.filter(
    ({ model, hasSecret }) =>
      model.enabled &&
      model.model_name.trim() &&
      hasSecret &&
      model.api_key_secret_key,
  );
}

function nodeContextWindow(model: OfficialModelConfig): number {
  return resolveContextWindow({
    model: model.model_name,
    configured: modelContextWindow(model),
  });
}

function publicPoolModel(settings: PlatformModelSettings): OfficialModelDto {
  const nodes = configuredNodes(settings);
  return {
    id: settings.pool.public_model_id,
    model_key: settings.pool.model_key,
    display_name: settings.pool.display_name,
    description: settings.pool.benefit_policy
      ? '有效会员专享，使用每日免费额度，不扣积分；限制每日对话次数与并发。'
      : '由平台统一调度可用模型节点，按公开 Token 价格计费。',
    model_name: settings.pool.model_key,
    context_window_tokens: nodes.length
      ? Math.min(...nodes.map(({ model }) => nodeContextWindow(model)))
      : null,
    input_token_price_per_million_coins:
      settings.pool.input_token_price_per_million_coins,
    output_token_price_per_million_coins:
      settings.pool.output_token_price_per_million_coins,
    has_secret: nodes.length > 0,
  };
}

function adminOverview(
  settings: PlatformModelSettings,
): AdminModelSettingsOverviewDto {
  return {
    revision: settings.pool.revision,
    enabled: settings.pool.enabled,
    ...(settings.pool.benefit_policy
      ? {
          benefit_policy: settings.pool.benefit_policy,
        }
      : {}),
    model: publicPoolModel(settings),
    thinking_level: normalizeThinkingLevel(settings.pool.thinking_level),
    nodes: settings.nodes.map(
      ({ model, weight, hasSecret, failureCount, cooldownUntil }) => ({
        id: model.id,
        is_primary: model.id === settings.pool.primary_node_id,
        display_name: model.display_name,
        model_name: model.model_name,
        pi_api: model.pi_api,
        base_url: model.base_url,
        auth_mode: normalizeAuthMode(model),
        context_window_tokens: modelContextWindow(model),
        enabled: model.enabled,
        weight,
        has_secret: hasSecret,
        failure_count: failureCount,
        cooldown_until: cooldownUntil,
        updated_at: model.updated_at,
      }),
    ),
  };
}

function resolvePlatformRuntime(
  settings: PlatformModelRuntimeSettings,
  poolKey: ModelPoolKey = 'official',
): EffectiveLlmRuntimeConfig | null {
  const eligible = new Set(
    configuredNodes(settings).map((entry) => entry.model.id),
  );
  const nodes = settings.nodes.filter(
    ({ model, hasSecret, secretValue }) =>
      model.enabled &&
      model.model_name.trim() &&
      hasSecret &&
      model.api_key_secret_key &&
      secretValue &&
      eligible.has(model.id),
  );
  if (!nodes.length) return null;
  const first = nodes[0];
  const model = first.model;
  const contextWindowTokens = Math.min(
    ...nodes.map(({ model }) => nodeContextWindow(model)),
  );
  return {
    source: 'official',
    poolKey,
    poolRevision: settings.pool.revision,
    ...(settings.pool.benefit_policy
      ? { benefitPolicy: settings.pool.benefit_policy }
      : {}),
    billingMode: poolKey === 'benefit' ? 'none' : 'metered',
    modelConfigId: settings.pool.public_model_id,
    providerKey: settings.pool.model_key,
    piApi: model.pi_api,
    displayName: settings.pool.display_name,
    authMode: normalizeAuthMode(model),
    secret: first.secretValue!,
    secretSource: 'database',
    baseUrl: model.base_url,
    model: model.model_name.trim(),
    contextWindowTokens,
    maxOutputTokens: Math.min(
      ...nodes.map(({ model }) =>
        getDefaultMaxOutputTokens(model.model_name, contextWindowTokens),
      ),
    ),
    thinkingLevel: normalizeThinkingLevel(settings.pool.thinking_level),
    inputTokenPricePerMillionCoins:
      settings.pool.input_token_price_per_million_coins,
    outputTokenPricePerMillionCoins:
      settings.pool.output_token_price_per_million_coins,
    poolNodes: nodes.map(({ model, weight, revision, secretValue }) => ({
      modelConfigId: model.id,
      revision,
      weight,
      piApi: model.pi_api,
      model: model.model_name.trim(),
      providerKey: model.model_key,
      authMode: normalizeAuthMode(model),
      apiKey: secretValue!,
      baseUrl: model.base_url ?? undefined,
      poolKey,
    })),
  };
}

export async function resolveOfficialLlmRuntime(
  poolKey: ModelPoolKey = 'official',
): Promise<EffectiveLlmRuntimeConfig | null> {
  return resolvePlatformRuntime(
    await (poolKey === 'official'
      ? getPlatformModelRuntimeSettings()
      : getPlatformModelRuntimeSettings(poolKey)),
    poolKey,
  );
}

/** API clients identify the pool by its stable public alias, never a node ID. */
export async function resolveOfficialRuntimeByModelKey(
  modelKey?: string,
): Promise<EffectiveLlmRuntimeConfig | null> {
  const settings = await getPlatformModelRuntimeSettings();
  if (modelKey !== undefined && settings.pool.model_key !== modelKey)
    return null;
  return resolvePlatformRuntime(settings);
}

export async function resolveUserLlmRuntime(
  _userId: string,
  poolKey: ModelPoolKey = 'official',
): Promise<EffectiveLlmRuntimeConfig> {
  const runtime = await resolveOfficialLlmRuntime(poolKey);
  if (!runtime)
    throw new ModelUnavailableError(
      poolKey === 'benefit'
        ? '免费模型暂不可用，请稍后重试或主动选择付费模型。'
        : '官方模型暂不可用，请联系管理员。',
    );
  return runtime;
}

export async function listPublicOfficialModels(): Promise<
  Array<{ model_key: string; display_name: string }>
> {
  const settings = await getPlatformModelSettings();
  return configuredNodes(settings).length
    ? [
        {
          model_key: settings.pool.model_key,
          display_name: settings.pool.display_name,
        },
      ]
    : [];
}

export async function getSystemConfigOverview(
  poolKey: ModelPoolKey = 'official',
): Promise<AdminModelSettingsOverviewDto> {
  return adminOverview(
    await (poolKey === 'official'
      ? getPlatformModelSettings()
      : getPlatformModelSettings(poolKey)),
  );
}

export async function getUserModelSettingsOverview(
  userId?: string,
): Promise<ModelSettingsOverviewDto> {
  const settings = await getPlatformModelSettings();
  const benefit = await getPlatformModelSettings('benefit');
  const policy = benefit.pool.benefit_policy!;
  const model = configuredNodes(settings).length
    ? publicPoolModel(settings)
    : null;
  const membershipActive = userId
    ? (await getRuntimeEntitlementSnapshot(userId)).membershipActive
    : false;
  if (model && userId && !membershipActive) {
    model.input_token_price_per_million_coins *= NON_MEMBER_PRICE_MULTIPLIER;
    model.output_token_price_per_million_coins *= NON_MEMBER_PRICE_MULTIPLIER;
  }
  return {
    model,
    preferred_pool: userId ? await getPreferredModelPool(userId) : 'official',
    benefit: {
      model: configuredNodes(benefit).length ? publicPoolModel(benefit) : null,
      enabled: benefit.pool.enabled,
      eligible: membershipActive,
      supply: await getBenefitSupply(),
      daily_turns: policy.daily_turns,
      ...(await getBenefitAllowance(
        membershipActive ? userId : undefined,
        policy.daily_turns,
      )),
    },
  };
}

function normalizeOfficialBaseUrl(value: string | null): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (!URL.canParse(raw))
    throw new ModelConfigurationError('请输入有效的接口地址');
  const url = new URL(raw);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ModelConfigurationError(
      '接口地址仅支持 HTTP 或 HTTPS，不能包含用户名、密码、查询参数或片段',
    );
  }
  return raw;
}

export async function saveOfficialModelSettings(
  input: AdminModelSettingsUpdateDto & { actor?: string },
  poolKey: ModelPoolKey = 'official',
): Promise<AdminModelSettingsOverviewDto> {
  if (poolKey === 'benefit') {
    if (!input.benefit_policy)
      throw new ModelConfigurationError('请配置免费额度与执行上限');
    if (input.enabled && !input.nodes.some((node) => node.enabled))
      throw new ModelConfigurationError(
        '开放免费服务前，请配置至少一个启用的节点',
      );
  }
  const updated = await savePlatformModelConfig({
    poolKey,
    revision: input.revision,
    enabled: input.enabled,
    benefitPolicy: input.benefit_policy,
    displayName: input.display_name.trim(),
    thinkingLevel: input.thinking_level,
    inputTokenPricePerMillionCoins:
      poolKey === 'benefit' ? 0 : input.input_token_price_per_million_coins,
    outputTokenPricePerMillionCoins:
      poolKey === 'benefit' ? 0 : input.output_token_price_per_million_coins,
    nodes: input.nodes.map((node) => ({
      id: node.id,
      displayName: node.display_name.trim(),
      piApi: node.pi_api,
      baseUrl: normalizeOfficialBaseUrl(node.base_url),
      modelName: node.model_name.trim(),
      secretValue: node.api_key,
      authMode: node.auth_mode,
      contextWindowTokens: normalizeConfiguredContextWindowTokens(
        node.context_window_tokens,
        node.display_name,
      ),
      enabled: node.enabled,
      weight: node.weight,
    })),
    actor: input.actor,
  });
  return adminOverview(updated);
}

export async function getAgentConcurrencyLimit(): Promise<number> {
  return (await getRuntimeConfig()).agent_concurrency_limit;
}

export async function getLocalAgentRuntimePolicy(): Promise<{
  maxProcesses: number;
  idleTtlMs: number;
}> {
  const config = await getRuntimeConfig();
  return {
    maxProcesses: config.local_agent_max_processes,
    idleTtlMs: config.local_agent_idle_ttl_ms,
  };
}

export async function getPiSessionHealthPolicy(): Promise<PiSessionHealthPolicy> {
  const config = await getRuntimeConfig();
  return {
    enabled: config.pi_session_health_enabled,
    inactiveCleanupDays: config.pi_session_inactive_cleanup_days,
    orphanGraceDays: config.pi_session_orphan_grace_days,
  };
}

export async function getSkillBundleLimitsPolicy(): Promise<SkillBundleLimitsPolicy> {
  const config = await getRuntimeConfig();
  return {
    max_files: config.skill_bundle_max_files,
    max_file_chars: config.skill_bundle_max_file_chars,
    max_total_chars: config.skill_bundle_max_total_chars,
    max_zip_bytes: config.skill_bundle_max_zip_bytes,
  };
}

export async function getUserSkillLimitPolicy(): Promise<number> {
  return (await getRuntimeConfig()).user_skill_max_count;
}
