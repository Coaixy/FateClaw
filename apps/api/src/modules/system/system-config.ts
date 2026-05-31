import { randomUUID } from 'node:crypto';

import {
  createConfigAuditLog,
  createOfficialModelConfig,
  deleteOfficialModelConfig,
  getOfficialModelConfig,
  getModelBillingConfig,
  getSystemSecret,
  getUserModelConfig,
  getUserModelSelection,
  listConfigAuditLogs,
  listOfficialModelConfigs,
  updateOfficialModelConfig,
  updateModelBillingConfig,
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
  UserModelConfig,
  UserModelSelection,
} from '../../shared/types.js';

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
}

export interface UserModelSettingsOverview {
  custom:
    | (UserModelConfig & {
        has_secret: boolean;
        auth_mode: ProviderAuthMode;
        context_window_tokens: number | null;
      })
    | null;
  selection: UserModelSelection | null;
  official_models: AdminOfficialModelView[];
  custom_model_platform_price_per_million_coins: number;
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

async function resolveSecret(input: {
  secretKey: string | null;
  piApi: ModelProviderType;
  extraJson?: Record<string, unknown> | null;
}): Promise<ResolvedProviderSecret> {
  const authMode = normalizeAuthMode(
    input.piApi,
    input.extraJson?.auth_mode,
  );
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
    inputTokenPricePerMillionCoins: model.input_token_price_per_million_coins,
    outputTokenPricePerMillionCoins:
      model.output_token_price_per_million_coins,
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

async function resolveLowestPricedOfficialRuntime(): Promise<
  EffectiveLlmRuntimeConfig | null
> {
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

  return lowest ? buildOfficialRuntime(lowest.model, lowest.secret) : null;
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
  return buildOfficialRuntime(model, { ...secret, value: secret.value });
}

async function resolveCustomRuntime(
  userId: string,
): Promise<EffectiveLlmRuntimeConfig> {
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
  const billingConfig = await getModelBillingConfig();
  const contextWindowTokens = resolveContextWindow({
    model: modelName,
    configured: normalizeModelContextWindowTokens(
      config.extra_json,
      '自配模型',
    ),
  });
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
    baseUrl: config.base_url,
    model: modelName,
    contextWindowTokens,
    maxOutputTokens: getDefaultMaxOutputTokens(modelName, contextWindowTokens),
    inputTokenPricePerMillionCoins:
      billingConfig.custom_model_platform_price_per_million_coins,
    outputTokenPricePerMillionCoins:
      billingConfig.custom_model_platform_price_per_million_coins,
  };
}

export function invalidateSystemConfigCache(): void {
  // 保留导出兼容测试和调用点。用户级模型选择不做全局 runtime 缓存。
}

export async function resolveUserLlmRuntime(
  userId: string,
): Promise<EffectiveLlmRuntimeConfig> {
  const selection = await getUserModelSelection(userId);
  if (!selection) {
    const fallbackRuntime = await resolveLowestPricedOfficialRuntime();
    if (fallbackRuntime) {
      return fallbackRuntime;
    }
    throw new Error('未选择模型，请先在模型设置中选择官方模型或自配模型');
  }
  if (selection.source === 'custom') {
    try {
      return await resolveCustomRuntime(userId);
    } catch (error) {
      const fallbackRuntime = await resolveLowestPricedOfficialRuntime();
      if (fallbackRuntime) {
        return fallbackRuntime;
      }
      throw error;
    }
  }
  try {
    return await resolveOfficialRuntime(selection);
  } catch (error) {
    const fallbackRuntime = await resolveLowestPricedOfficialRuntime();
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

export async function listOfficialModelViews(): Promise<
  AdminOfficialModelView[]
> {
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
  runtime: null;
  audit_logs: Awaited<ReturnType<typeof listConfigAuditLogs>>;
}> {
  const [models, auditLogs, modelBilling] = await Promise.all([
    listOfficialModelViews(),
    listConfigAuditLogs(50),
    getModelBillingConfig(),
  ]);
  return {
    official_models: models,
    providers: models,
    model_billing: {
      custom_model_platform_price_per_million_coins:
        modelBilling.custom_model_platform_price_per_million_coins,
      updated_at: modelBilling.updated_at,
    },
    runtime: null,
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

export async function setOfficialModelSecret(args: {
  modelId: string;
  secretValue: string;
  authMode?: ProviderAuthMode;
  actor?: string;
}): Promise<void> {
  const actor = args.actor ?? 'admin';
  const model = await getOfficialModelConfig(args.modelId);
  if (!model) {
    throw new Error('官方模型不存在');
  }
  const secretKey =
    model.api_key_secret_key || `official-model:${model.id}:secret`;
  await upsertSystemSecret({
    key: secretKey,
    secretValue: args.secretValue,
    updatedBy: actor,
  });
  await updateOfficialModelConfig({
    id: model.id,
    modelKey: model.model_key,
    piApi: model.pi_api,
    displayName: model.display_name,
    enabled: model.enabled,
    priority: model.priority,
    baseUrl: model.base_url,
    modelName: model.model_name,
    apiKeySecretKey: secretKey,
    inputTokenPricePerMillionCoins: model.input_token_price_per_million_coins,
    outputTokenPricePerMillionCoins:
      model.output_token_price_per_million_coins,
    extraJson: {
      ...(model.extra_json ?? {}),
      auth_mode: args.authMode ?? defaultAuthMode(model.pi_api),
    },
  });
  await createConfigAuditLog({
    id: `cfg-audit-${randomUUID()}`,
    actorUserId: actor,
    action: 'official_model.secret.updated',
    targetType: 'official_model',
    targetKey: model.id,
    before: { had_secret: Boolean(model.api_key_secret_key) },
    after: { secret_key: secretKey },
  });
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
  const secretKey = args.secretValue
    ? `official-model:${id}:secret`
    : null;
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
    outputTokenPricePerMillionCoins:
      args.outputTokenPricePerMillionCoins ?? 0,
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
  const updated = await updateOfficialModelConfig({
    id: args.id,
    modelKey: args.modelKey,
    piApi: args.piApi,
    displayName: args.displayName,
    enabled: args.enabled,
    priority: args.priority,
    baseUrl: args.baseUrl ?? null,
    modelName: args.modelName,
    apiKeySecretKey: before.api_key_secret_key,
    inputTokenPricePerMillionCoins: args.inputTokenPricePerMillionCoins,
    outputTokenPricePerMillionCoins: args.outputTokenPricePerMillionCoins,
    extraJson: withModelDescription(
      withModelContextWindowTokens(
        before.extra_json,
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
  await deleteOfficialModelConfig(id);
  await createConfigAuditLog({
    id: `cfg-audit-${randomUUID()}`,
    actorUserId: actor,
    action: 'official_model.deleted',
    targetType: 'official_model',
    targetKey: id,
    before: target,
  });
}

export async function getUserModelSettingsOverview(
  userId: string,
): Promise<UserModelSettingsOverview> {
  const [custom, selection, officialModels, modelBilling] = await Promise.all([
    getUserModelConfig(userId),
    getUserModelSelection(userId),
    listOfficialModelViews(),
    getModelBillingConfig(),
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
          auth_mode: customSecret?.authMode ?? defaultAuthMode(custom.pi_api),
          context_window_tokens: normalizeModelContextWindowTokens(
            custom.extra_json,
            '自配模型',
          ),
        }
      : null,
    selection: selection ?? null,
    official_models: officialModels,
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
  const existing = await getUserModelConfig(args.userId);
  const secretKey = args.secretValue
    ? existing?.api_key_secret_key ?? `user-model:${args.userId}:secret`
    : existing?.api_key_secret_key ?? null;
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
    baseUrl: args.baseUrl ?? null,
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

export async function setUserCustomModelSecret(args: {
  userId: string;
  secretValue: string;
  authMode?: ProviderAuthMode;
}): Promise<void> {
  const config = await getUserModelConfig(args.userId);
  if (!config) {
    throw new Error('请先保存自配模型基础配置');
  }
  const secretKey =
    config.api_key_secret_key || `user-model:${args.userId}:secret`;
  await upsertSystemSecret({
    key: secretKey,
    secretValue: args.secretValue,
    updatedBy: args.userId,
  });
  await upsertUserModelConfig({
    userId: args.userId,
    piApi: config.pi_api,
    baseUrl: config.base_url,
    modelName: config.model_name,
    apiKeySecretKey: secretKey,
    extraJson: {
      ...(config.extra_json ?? {}),
      auth_mode: args.authMode ?? defaultAuthMode(config.pi_api),
    },
  });
}

export async function setUserModelSelection(args: {
  userId: string;
  source: UserModelSelection['source'];
  officialModelId?: string | null;
}): Promise<UserModelSelection> {
  if (args.source === 'official') {
    if (!args.officialModelId) {
      throw new Error('请选择官方模型');
    }
    const model = await getOfficialModelConfig(args.officialModelId);
    if (!model || !model.enabled) {
      throw new Error('选择的官方模型不可用');
    }
  }
  return upsertUserModelSelection({
    userId: args.userId,
    source: args.source,
    officialModelId:
      args.source === 'official' ? (args.officialModelId ?? null) : null,
  });
}
