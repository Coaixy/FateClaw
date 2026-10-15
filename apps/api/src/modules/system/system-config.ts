import {
  getPlatformModelSettings,
  getPlatformModelRuntimeSettings,
  savePlatformModelConfig,
} from '../../infrastructure/db.js';
import {
  ModelConfigurationError,
  type PlatformModelSettings,
  type PlatformModelRuntimeSettings,
} from '../../infrastructure/repositories/config-repository.js';
import { getDefaultMaxOutputTokens } from '../../shared/output-token-policy.js';
import {
  normalizeConfiguredContextWindowTokens,
  resolveContextWindow,
} from '../../shared/model-context-window.js';
import type {
  ModelProviderType,
  OfficialModelConfig,
  PiThinkingLevel,
} from '../../shared/types.js';
import { PI_THINKING_LEVELS } from '../../shared/types.js';
import type {
  AdminModelSettingsOverviewDto,
  AdminModelSettingsUpdateDto,
  RuntimeModelPoolNode,
  ModelAuthModeDto,
  ModelSettingsOverviewDto,
  OfficialModelDto,
} from '@fateclaw/contracts/model-settings';
import {
  MAX_SKILL_BUNDLE_FILE_LENGTH,
  MAX_SKILL_BUNDLE_FILES,
  MAX_SKILL_BUNDLE_TOTAL_LENGTH,
  MAX_SKILL_BUNDLE_ZIP_BYTES,
  MAX_USER_SKILLS,
  type SkillBundleLimitsDto,
} from '@fateclaw/contracts/skills';

type RuntimeSecretSource = 'database' | 'missing';
export type ProviderAuthMode = ModelAuthModeDto;
// Historical billing snapshots can still contain custom model requests.
export type LlmRuntimeSource = 'custom' | 'official';
export type LlmBillingMode = 'none' | 'metered';
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
    description: '由平台统一调度可用模型节点，按公开 Token 价格计费。',
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
): EffectiveLlmRuntimeConfig | null {
  const nodes = settings.nodes.filter(
    ({ model, hasSecret, secretValue }) =>
      model.enabled &&
      model.model_name.trim() &&
      hasSecret &&
      model.api_key_secret_key &&
      secretValue,
  );
  if (!nodes.length) return null;
  const first = nodes[0];
  const model = first.model;
  const contextWindowTokens = Math.min(
    ...nodes.map(({ model }) => nodeContextWindow(model)),
  );
  return {
    source: 'official',
    billingMode: 'metered',
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
    })),
  };
}

export async function resolveOfficialLlmRuntime(): Promise<EffectiveLlmRuntimeConfig | null> {
  return resolvePlatformRuntime(await getPlatformModelRuntimeSettings());
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
): Promise<EffectiveLlmRuntimeConfig> {
  const runtime = await resolveOfficialLlmRuntime();
  if (!runtime) throw new Error('官方模型暂不可用，请联系管理员。');
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

export async function getSystemConfigOverview(): Promise<AdminModelSettingsOverviewDto> {
  return adminOverview(await getPlatformModelSettings());
}

export async function getUserModelSettingsOverview(
  _userId?: string,
): Promise<ModelSettingsOverviewDto> {
  const settings = await getPlatformModelSettings();
  return {
    model: configuredNodes(settings).length ? publicPoolModel(settings) : null,
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
): Promise<AdminModelSettingsOverviewDto> {
  const updated = await savePlatformModelConfig({
    displayName: input.display_name.trim(),
    thinkingLevel: input.thinking_level,
    inputTokenPricePerMillionCoins: input.input_token_price_per_million_coins,
    outputTokenPricePerMillionCoins: input.output_token_price_per_million_coins,
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
  return DEFAULT_AGENT_CONCURRENCY_LIMIT;
}

export async function getLocalAgentRuntimePolicy(): Promise<{
  maxProcesses: number;
  idleTtlMs: number;
}> {
  return {
    maxProcesses: DEFAULT_LOCAL_AGENT_MAX_PROCESSES,
    idleTtlMs: DEFAULT_LOCAL_AGENT_IDLE_TTL_MS,
  };
}

export async function getPiSessionHealthPolicy(): Promise<PiSessionHealthPolicy> {
  return {
    enabled: false,
    inactiveCleanupDays: DEFAULT_PI_SESSION_INACTIVE_CLEANUP_DAYS,
    orphanGraceDays: DEFAULT_PI_SESSION_ORPHAN_GRACE_DAYS,
  };
}

export async function getSkillBundleLimitsPolicy(): Promise<SkillBundleLimitsPolicy> {
  return {
    max_files: DEFAULT_SKILL_BUNDLE_MAX_FILES,
    max_file_chars: DEFAULT_SKILL_BUNDLE_MAX_FILE_CHARS,
    max_total_chars: DEFAULT_SKILL_BUNDLE_MAX_TOTAL_CHARS,
    max_zip_bytes: DEFAULT_SKILL_BUNDLE_MAX_ZIP_BYTES,
  };
}

export async function getUserSkillLimitPolicy(): Promise<number> {
  return DEFAULT_USER_SKILL_MAX_COUNT;
}
