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
import {
  MAX_SKILL_BUNDLE_FILE_LENGTH,
  MAX_SKILL_BUNDLE_FILES,
  MAX_SKILL_BUNDLE_TOTAL_LENGTH,
  MAX_SKILL_BUNDLE_ZIP_BYTES,
  MAX_USER_SKILLS,
} from '@fateclaw/contracts/skills';
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

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const numeric =
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
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
    `INSERT INTO runtime_config (
       id, agent_concurrency_limit, local_agent_max_processes,
       local_agent_idle_ttl_ms, default_official_model_id, default_thinking_level,
       pi_session_health_enabled,
       pi_session_inactive_cleanup_days, pi_session_orphan_grace_days,
       user_skill_max_count,
       skill_bundle_max_files, skill_bundle_max_file_chars,
       skill_bundle_max_total_chars, skill_bundle_max_zip_bytes
     )
     VALUES ('default', 10, 4, 600000, NULL, 'medium', false, 30, 30, $1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING *`,
    [
      MAX_USER_SKILLS,
      MAX_SKILL_BUNDLE_FILES,
      MAX_SKILL_BUNDLE_FILE_LENGTH,
      MAX_SKILL_BUNDLE_TOTAL_LENGTH,
      MAX_SKILL_BUNDLE_ZIP_BYTES,
    ],
  );
  return rows[0] as RuntimeConfig;
}

/**
 * 更新全站 Agent 运行时策略。
 */
export async function updateRuntimeConfig(input: {
  agentConcurrencyLimit?: number;
  agentRequestTimeoutMs?: number;
  agentAccountConcurrency?: number;
  localAgentMaxProcesses?: number;
  localAgentIdleTtlMs?: number;
  defaultOfficialModelId?: string | null;
  defaultThinkingLevel?: RuntimeConfig['default_thinking_level'];
  piSessionHealthEnabled?: boolean;
  piSessionInactiveCleanupDays?: number;
  piSessionOrphanGraceDays?: number;
  userSkillMaxCount?: number;
  skillBundleMaxFiles?: number;
  skillBundleMaxFileChars?: number;
  skillBundleMaxTotalChars?: number;
  skillBundleMaxZipBytes?: number;
}): Promise<RuntimeConfig> {
  const current = await getRuntimeConfig();
  const agentConcurrencyLimit = Math.max(
    1,
    Math.floor(input.agentConcurrencyLimit ?? current.agent_concurrency_limit),
  );
  // 单请求超时:1~60 分钟,默认 30 分钟。注入 agent-runtime 后由 daemon 强制中断挂死请求。
  const agentRequestTimeoutMs = Math.min(
    3_600_000,
    Math.max(
      60_000,
      Math.floor(
        input.agentRequestTimeoutMs ?? current.agent_request_timeout_ms,
      ),
    ),
  );
  // 每账号并发:1~16,默认 1。注入 agent-runtime 后控制单账号同时处理的请求数。
  const agentAccountConcurrency = Math.min(
    16,
    Math.max(
      1,
      Math.floor(
        input.agentAccountConcurrency ?? current.agent_account_concurrency,
      ),
    ),
  );
  const localAgentMaxProcesses = Math.min(
    100,
    Math.max(
      1,
      Math.floor(
        input.localAgentMaxProcesses ?? current.local_agent_max_processes,
      ),
    ),
  );
  const localAgentIdleTtlMs = Math.min(
    86_400_000,
    Math.max(
      30_000,
      Math.floor(input.localAgentIdleTtlMs ?? current.local_agent_idle_ttl_ms),
    ),
  );
  const defaultOfficialModelId =
    input.defaultOfficialModelId === undefined
      ? current.default_official_model_id
      : (input.defaultOfficialModelId?.trim() ?? null) || null;
  const defaultThinkingLevel =
    input.defaultThinkingLevel ?? current.default_thinking_level ?? 'medium';
  const piSessionHealthEnabled =
    input.piSessionHealthEnabled ?? current.pi_session_health_enabled;
  const piSessionInactiveCleanupDays = Math.min(
    3650,
    Math.max(
      1,
      Math.floor(
        input.piSessionInactiveCleanupDays ??
          current.pi_session_inactive_cleanup_days,
      ),
    ),
  );
  const piSessionOrphanGraceDays = Math.min(
    3650,
    Math.max(
      1,
      Math.floor(
        input.piSessionOrphanGraceDays ?? current.pi_session_orphan_grace_days,
      ),
    ),
  );
  const userSkillMaxCount = clampInteger(
    input.userSkillMaxCount ?? current.user_skill_max_count,
    MAX_USER_SKILLS,
    1,
    500,
  );
  const skillBundleMaxFiles = clampInteger(
    input.skillBundleMaxFiles ?? current.skill_bundle_max_files,
    MAX_SKILL_BUNDLE_FILES,
    1,
    500,
  );
  const skillBundleMaxFileChars = clampInteger(
    input.skillBundleMaxFileChars ?? current.skill_bundle_max_file_chars,
    MAX_SKILL_BUNDLE_FILE_LENGTH,
    1,
    2_000_000,
  );
  const skillBundleMaxTotalChars = clampInteger(
    input.skillBundleMaxTotalChars ?? current.skill_bundle_max_total_chars,
    MAX_SKILL_BUNDLE_TOTAL_LENGTH,
    skillBundleMaxFileChars,
    10_000_000,
  );
  const skillBundleMaxZipBytes = clampInteger(
    input.skillBundleMaxZipBytes ?? current.skill_bundle_max_zip_bytes,
    MAX_SKILL_BUNDLE_ZIP_BYTES,
    1024,
    100 * 1024 * 1024,
  );
  const { rows } = await getDbPool().query(
    `INSERT INTO runtime_config (
       id, agent_concurrency_limit, local_agent_max_processes,
       local_agent_idle_ttl_ms, default_official_model_id, default_thinking_level,
       pi_session_health_enabled,
       pi_session_inactive_cleanup_days, pi_session_orphan_grace_days,
       user_skill_max_count,
       skill_bundle_max_files, skill_bundle_max_file_chars,
       skill_bundle_max_total_chars, skill_bundle_max_zip_bytes,
       agent_request_timeout_ms, agent_account_concurrency,
       updated_at
     )
     VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
     ON CONFLICT (id) DO UPDATE SET
       agent_concurrency_limit = EXCLUDED.agent_concurrency_limit,
       local_agent_max_processes = EXCLUDED.local_agent_max_processes,
       local_agent_idle_ttl_ms = EXCLUDED.local_agent_idle_ttl_ms,
       default_official_model_id = EXCLUDED.default_official_model_id,
       default_thinking_level = EXCLUDED.default_thinking_level,
       pi_session_health_enabled = EXCLUDED.pi_session_health_enabled,
       pi_session_inactive_cleanup_days = EXCLUDED.pi_session_inactive_cleanup_days,
       pi_session_orphan_grace_days = EXCLUDED.pi_session_orphan_grace_days,
       user_skill_max_count = EXCLUDED.user_skill_max_count,
       skill_bundle_max_files = EXCLUDED.skill_bundle_max_files,
       skill_bundle_max_file_chars = EXCLUDED.skill_bundle_max_file_chars,
       skill_bundle_max_total_chars = EXCLUDED.skill_bundle_max_total_chars,
       skill_bundle_max_zip_bytes = EXCLUDED.skill_bundle_max_zip_bytes,
       agent_request_timeout_ms = EXCLUDED.agent_request_timeout_ms,
       agent_account_concurrency = EXCLUDED.agent_account_concurrency,
       updated_at = NOW()
     RETURNING *`,
    [
      agentConcurrencyLimit,
      localAgentMaxProcesses,
      localAgentIdleTtlMs,
      defaultOfficialModelId,
      defaultThinkingLevel,
      piSessionHealthEnabled,
      piSessionInactiveCleanupDays,
      piSessionOrphanGraceDays,
      userSkillMaxCount,
      skillBundleMaxFiles,
      skillBundleMaxFileChars,
      skillBundleMaxTotalChars,
      skillBundleMaxZipBytes,
      agentRequestTimeoutMs,
      agentAccountConcurrency,
    ],
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
  thinkingLevel: NonNullable<UserModelSelection['thinking_level']>;
}): Promise<UserModelSelection> {
  const { rows } = await getDbPool().query(
    `INSERT INTO user_model_selections
       (user_id, source, official_model_id, thinking_level, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       source = EXCLUDED.source,
       official_model_id = EXCLUDED.official_model_id,
       thinking_level = EXCLUDED.thinking_level,
       updated_at = NOW()
     RETURNING *`,
    [
      input.userId,
      input.source,
      input.officialModelId ?? null,
      input.thinkingLevel,
    ],
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

/**
 * 分页读取配置变更审计日志。
 *
 * @param args.limit 每页条数(1~100)。
 * @param args.offset 偏移量(>=0)。
 * @returns 当前页条目与总条数;total 用单独的 COUNT 查询保证 offset 越界时仍准确。
 */
export async function listConfigAuditLogsPaged(args: {
  limit: number;
  offset: number;
}): Promise<{ items: ConfigAuditLog[]; total: number }> {
  const limit = Math.min(Math.max(Math.floor(args.limit), 1), 100);
  const offset = Math.max(Math.floor(args.offset), 0);
  const [page, count] = await Promise.all([
    getDbPool().query(
      `SELECT *
       FROM config_audit_logs
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    ),
    getDbPool().query(`SELECT COUNT(*)::int AS total FROM config_audit_logs`),
  ]);
  return {
    items: page.rows as ConfigAuditLog[],
    total: (count.rows[0]?.total as number | undefined) ?? 0,
  };
}
