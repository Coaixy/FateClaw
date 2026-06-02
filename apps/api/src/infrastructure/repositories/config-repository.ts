import {
  ConfigAuditLog,
  ModelBillingConfig,
  ModelProviderType,
  OfficialModelConfig,
  RuntimeConfig,
  SystemSecretRow,
  UserModelConfig,
  UserModelSelection,
} from '../../shared/types.js';
import { getDbPool } from '../db-pool.js';

type JsonObject = Record<string, unknown>;

function toJsonObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function mapOfficialModelRow(row: unknown): OfficialModelConfig {
  const record = row as OfficialModelConfig;
  return {
    ...record,
    extra_json: toJsonObject(record.extra_json),
  };
}

function mapUserModelRow(row: unknown): UserModelConfig {
  const record = row as UserModelConfig;
  return {
    ...record,
    extra_json: toJsonObject(record.extra_json),
  };
}

export async function getSystemSecret(
  key: string,
): Promise<SystemSecretRow | undefined> {
  const { rows } = await getDbPool().query(
    'SELECT * FROM system_secrets WHERE key = $1',
    [key],
  );
  return rows[0] as SystemSecretRow | undefined;
}

export async function upsertSystemSecret(input: {
  key: string;
  secretValue: string;
  updatedBy?: string | null;
}): Promise<SystemSecretRow> {
  const { rows } = await getDbPool().query(
    `INSERT INTO system_secrets
       (key, secret_value, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET
       secret_value = EXCLUDED.secret_value,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING *`,
    [input.key, input.secretValue, input.updatedBy ?? null],
  );
  return rows[0] as SystemSecretRow;
}

export async function listOfficialModelConfigs(): Promise<
  OfficialModelConfig[]
> {
  const { rows } = await getDbPool().query(
    `SELECT *
     FROM official_model_configs
     ORDER BY enabled DESC, priority ASC, created_at ASC`,
  );
  return rows.map(mapOfficialModelRow);
}

export async function getOfficialModelConfig(
  id: string,
): Promise<OfficialModelConfig | undefined> {
  const { rows } = await getDbPool().query(
    'SELECT * FROM official_model_configs WHERE id = $1',
    [id],
  );
  return rows[0] ? mapOfficialModelRow(rows[0]) : undefined;
}

export async function createOfficialModelConfig(input: {
  id: string;
  modelKey: string;
  piApi: ModelProviderType;
  displayName: string;
  enabled?: boolean;
  priority?: number;
  baseUrl?: string | null;
  modelName: string;
  apiKeySecretKey?: string | null;
  inputTokenPricePerMillionCoins?: number;
  outputTokenPricePerMillionCoins?: number;
  extraJson?: Record<string, unknown> | null;
}): Promise<OfficialModelConfig> {
  const { rows } = await getDbPool().query(
    `INSERT INTO official_model_configs
       (
         id, model_key, pi_api, display_name, enabled, priority,
         base_url, model_name, api_key_secret_key,
         input_token_price_per_million_coins,
         output_token_price_per_million_coins,
         extra_json, created_at, updated_at
       )
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
     RETURNING *`,
    [
      input.id,
      input.modelKey,
      input.piApi,
      input.displayName,
      input.enabled ?? true,
      input.priority ?? 0,
      input.baseUrl ?? null,
      input.modelName,
      input.apiKeySecretKey ?? null,
      input.inputTokenPricePerMillionCoins ?? 0,
      input.outputTokenPricePerMillionCoins ?? 0,
      JSON.stringify(input.extraJson ?? {}),
    ],
  );
  return mapOfficialModelRow(rows[0]);
}

export async function updateOfficialModelConfig(input: {
  id: string;
  modelKey: string;
  piApi: ModelProviderType;
  displayName: string;
  enabled: boolean;
  priority: number;
  baseUrl?: string | null;
  modelName: string;
  apiKeySecretKey?: string | null;
  inputTokenPricePerMillionCoins: number;
  outputTokenPricePerMillionCoins: number;
  extraJson?: Record<string, unknown> | null;
}): Promise<OfficialModelConfig | undefined> {
  const { rows } = await getDbPool().query(
    `UPDATE official_model_configs
     SET model_key = $2,
         pi_api = $3,
         display_name = $4,
         enabled = $5,
         priority = $6,
         base_url = $7,
         model_name = $8,
         api_key_secret_key = $9,
         input_token_price_per_million_coins = $10,
         output_token_price_per_million_coins = $11,
         extra_json = $12,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      input.id,
      input.modelKey,
      input.piApi,
      input.displayName,
      input.enabled,
      input.priority,
      input.baseUrl ?? null,
      input.modelName,
      input.apiKeySecretKey ?? null,
      input.inputTokenPricePerMillionCoins,
      input.outputTokenPricePerMillionCoins,
      JSON.stringify(input.extraJson ?? {}),
    ],
  );
  return rows[0] ? mapOfficialModelRow(rows[0]) : undefined;
}

/**
 * 删除指向指定官方模型的用户选择。
 *
 * @param officialModelId 即将被删除的官方模型 ID。
 * @returns 被清理的用户选择数量。
 */
export async function deleteUserModelSelectionsByOfficialModelId(
  officialModelId: string,
): Promise<number> {
  const { rowCount } = await getDbPool().query(
    'DELETE FROM user_model_selections WHERE official_model_id = $1',
    [officialModelId],
  );
  return rowCount ?? 0;
}

export async function deleteOfficialModelConfig(id: string): Promise<void> {
  await getDbPool().query('DELETE FROM official_model_configs WHERE id = $1', [
    id,
  ]);
}

/**
 * 读取模型计费全局配置；缺省行不存在时自动补齐。
 */
export async function getModelBillingConfig(): Promise<ModelBillingConfig> {
  const { rows } = await getDbPool().query(
    `INSERT INTO model_billing_config (id)
     VALUES ('default')
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING *`,
  );
  return rows[0] as ModelBillingConfig;
}

/**
 * 更新自配模型平台 Token 服务费。
 */
export async function updateModelBillingConfig(input: {
  customModelPlatformPricePerMillionCoins: number;
}): Promise<ModelBillingConfig> {
  const { rows } = await getDbPool().query(
    `INSERT INTO model_billing_config (
       id, custom_model_platform_price_per_million_coins, updated_at
     )
     VALUES ('default', $1, NOW())
     ON CONFLICT (id) DO UPDATE SET
       custom_model_platform_price_per_million_coins =
         EXCLUDED.custom_model_platform_price_per_million_coins,
       updated_at = NOW()
     RETURNING *`,
    [input.customModelPlatformPricePerMillionCoins],
  );
  return rows[0] as ModelBillingConfig;
}

/**
 * 读取 Agent 运行时全局配置；缺省行不存在时自动补齐。
 */
export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  const { rows } = await getDbPool().query(
    `INSERT INTO runtime_config (id)
     VALUES ('default')
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING *`,
  );
  return rows[0] as RuntimeConfig;
}

/**
 * 更新全站 Agent 并发槽位上限。
 */
export async function updateRuntimeConfig(input: {
  agentConcurrencyLimit: number;
}): Promise<RuntimeConfig> {
  const { rows } = await getDbPool().query(
    `INSERT INTO runtime_config (
       id, agent_concurrency_limit, updated_at
     )
     VALUES ('default', $1, NOW())
     ON CONFLICT (id) DO UPDATE SET
       agent_concurrency_limit = EXCLUDED.agent_concurrency_limit,
       updated_at = NOW()
     RETURNING *`,
    [Math.max(1, Math.floor(input.agentConcurrencyLimit))],
  );
  return rows[0] as RuntimeConfig;
}

export async function getUserModelConfig(
  userId: string,
): Promise<UserModelConfig | undefined> {
  const { rows } = await getDbPool().query(
    'SELECT * FROM user_model_configs WHERE user_id = $1',
    [userId],
  );
  return rows[0] ? mapUserModelRow(rows[0]) : undefined;
}

export async function upsertUserModelConfig(input: {
  userId: string;
  piApi: ModelProviderType;
  baseUrl?: string | null;
  modelName: string;
  apiKeySecretKey?: string | null;
  extraJson?: Record<string, unknown> | null;
}): Promise<UserModelConfig> {
  const { rows } = await getDbPool().query(
    `INSERT INTO user_model_configs
       (user_id, pi_api, base_url, model_name, api_key_secret_key,
        extra_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       pi_api = EXCLUDED.pi_api,
       base_url = EXCLUDED.base_url,
       model_name = EXCLUDED.model_name,
       api_key_secret_key = EXCLUDED.api_key_secret_key,
       extra_json = EXCLUDED.extra_json,
       updated_at = NOW()
     RETURNING *`,
    [
      input.userId,
      input.piApi,
      input.baseUrl ?? null,
      input.modelName,
      input.apiKeySecretKey ?? null,
      JSON.stringify(input.extraJson ?? {}),
    ],
  );
  return mapUserModelRow(rows[0]);
}

export async function getUserModelSelection(
  userId: string,
): Promise<UserModelSelection | undefined> {
  const { rows } = await getDbPool().query(
    'SELECT * FROM user_model_selections WHERE user_id = $1',
    [userId],
  );
  return rows[0] as UserModelSelection | undefined;
}

export async function upsertUserModelSelection(input: {
  userId: string;
  source: UserModelSelection['source'];
  officialModelId?: string | null;
}): Promise<UserModelSelection> {
  const { rows } = await getDbPool().query(
    `INSERT INTO user_model_selections
       (user_id, source, official_model_id, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       source = EXCLUDED.source,
       official_model_id = EXCLUDED.official_model_id,
       updated_at = NOW()
     RETURNING *`,
    [input.userId, input.source, input.officialModelId ?? null],
  );
  return rows[0] as UserModelSelection;
}

export async function createConfigAuditLog(input: {
  id: string;
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetKey: string;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  await getDbPool().query(
    `INSERT INTO config_audit_logs
       (
         id, actor_user_id, action, target_type, target_key,
         before_json, after_json, created_at
       )
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [
      input.id,
      input.actorUserId ?? null,
      input.action,
      input.targetType,
      input.targetKey,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
    ],
  );
}

export async function listConfigAuditLogs(
  limit = 50,
): Promise<ConfigAuditLog[]> {
  const { rows } = await getDbPool().query(
    `SELECT *
     FROM config_audit_logs
     ORDER BY created_at DESC
     LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return rows as ConfigAuditLog[];
}
