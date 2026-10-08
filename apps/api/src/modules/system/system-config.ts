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
  AdminOfficialModelDto,
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

function publicModel(settings: PlatformModelSettings): OfficialModelDto | null {
  const model = settings.model;
  if (!model) return null;
  return {
    id: model.id,
    model_key: model.model_key,
    display_name: model.display_name,
    description:
      typeof model.extra_json?.description === 'string'
        ? model.extra_json.description.trim()
        : '',
    model_name: model.model_name,
    context_window_tokens: modelContextWindow(model),
    input_token_price_per_million_coins:
      model.input_token_price_per_million_coins,
    output_token_price_per_million_coins:
      model.output_token_price_per_million_coins,
    has_secret: settings.hasSecret,
  };
}

function adminOverview(
  settings: PlatformModelSettings,
): AdminModelSettingsOverviewDto {
  const model = settings.model;
  const view = publicModel(settings);
  const adminModel: AdminOfficialModelDto | null =
    model && view
      ? {
          ...view,
          pi_api: model.pi_api,
          base_url: model.base_url,
          auth_mode: normalizeAuthMode(model),
          updated_at: model.updated_at,
        }
      : null;
  return {
    model: adminModel,
    thinking_level: normalizeThinkingLevel(settings.thinkingLevel),
  };
}

function resolvePlatformRuntime(
  settings: PlatformModelRuntimeSettings,
): EffectiveLlmRuntimeConfig | null {
  const model = settings.model;
  if (
    !model?.enabled ||
    !model.model_name.trim() ||
    !settings.hasSecret ||
    !model.api_key_secret_key
  ) {
    return null;
  }
  if (!settings.secretValue) return null;
  const modelName = model.model_name.trim();
  const contextWindowTokens = resolveContextWindow({
    model: modelName,
    configured: modelContextWindow(model),
  });
  return {
    source: 'official',
    billingMode: 'metered',
    modelConfigId: model.id,
    providerKey: model.model_key,
    piApi: model.pi_api,
    displayName: model.display_name,
    authMode: normalizeAuthMode(model),
    secret: settings.secretValue,
    secretSource: 'database',
    baseUrl: model.base_url,
    model: modelName,
    contextWindowTokens,
    maxOutputTokens: getDefaultMaxOutputTokens(modelName, contextWindowTokens),
    thinkingLevel: normalizeThinkingLevel(settings.thinkingLevel),
    inputTokenPricePerMillionCoins: model.input_token_price_per_million_coins,
    outputTokenPricePerMillionCoins: model.output_token_price_per_million_coins,
  };
}

export async function resolveOfficialLlmRuntime(): Promise<EffectiveLlmRuntimeConfig | null> {
  return resolvePlatformRuntime(await getPlatformModelRuntimeSettings());
}

/** Only the platform slot is available; API clients may identify it by its existing alias. */
export async function resolveOfficialRuntimeByModelKey(
  modelKey?: string,
): Promise<EffectiveLlmRuntimeConfig | null> {
  const settings = await getPlatformModelRuntimeSettings();
  if (modelKey !== undefined && settings.model?.model_key !== modelKey)
    return null;
  return resolvePlatformRuntime(settings);
}

export async function resolveUserLlmRuntime(
  _userId: string,
): Promise<EffectiveLlmRuntimeConfig> {
  const runtime = await resolveOfficialLlmRuntime();
  if (!runtime) throw new Error('The official model is unavailable. Please contact the administrator.');
  return runtime;
}

export async function listPublicOfficialModels(): Promise<
  Array<{ model_key: string; display_name: string }>
> {
  const settings = await getPlatformModelSettings();
  const model = settings.model;
  return model?.enabled && model.model_name.trim() && settings.hasSecret
    ? [{ model_key: model.model_key, display_name: model.display_name }]
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
    model: settings.model?.enabled ? publicModel(settings) : null,
  };
}

function normalizeOfficialBaseUrl(value: string | null): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (!URL.canParse(raw))
    throw new ModelConfigurationError('Enter a valid base URL');
  const url = new URL(raw);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ModelConfigurationError(
      'Use an HTTP or HTTPS base URL without credentials, query parameters, or fragments',
    );
  }
  return raw;
}

export async function saveOfficialModelSettings(
  input: AdminModelSettingsUpdateDto & { actor?: string },
): Promise<AdminModelSettingsOverviewDto> {
  const updated = await savePlatformModelConfig({
    piApi: input.pi_api,
    baseUrl: normalizeOfficialBaseUrl(input.base_url),
    modelName: input.model_name.trim(),
    secretValue: input.api_key,
    authMode: input.auth_mode,
    contextWindowTokens: normalizeConfiguredContextWindowTokens(
      input.context_window_tokens,
      'Official model',
    ),
    thinkingLevel: input.thinking_level,
    inputTokenPricePerMillionCoins: input.input_token_price_per_million_coins,
    outputTokenPricePerMillionCoins: input.output_token_price_per_million_coins,
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
