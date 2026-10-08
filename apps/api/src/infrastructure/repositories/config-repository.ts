import type {
  ModelProviderType,
  OfficialModelConfig,
  PiThinkingLevel,
} from '../../shared/types.js';
import { getDbPool, type DbQueryable } from '../db-pool.js';
import type { ModelAuthModeDto } from '@fateclaw/contracts/model-settings';

export class ModelConfigurationError extends Error {
  readonly statusCode = 400;
}

export interface PlatformModelSettings {
  model: OfficialModelConfig | null;
  thinkingLevel: PiThinkingLevel;
  hasSecret: boolean;
}

export interface PlatformModelRuntimeSettings extends PlatformModelSettings {
  secretValue: string | null;
}

async function readPlatformModelSettings(
  db: DbQueryable,
  includeCredential = false,
): Promise<PlatformModelSettings & { secretValue?: string | null }> {
  // Legacy installations reuse their default model, or adopt their first existing slot.
  // An explicitly configured but unavailable model must never select a different provider.
  const { rows } = await db.query<{
    model: OfficialModelConfig | null;
    default_thinking_level: PiThinkingLevel;
    has_secret: boolean;
    secret_value?: string | null;
  }>(
    `WITH settings AS (
       SELECT default_official_model_id, default_thinking_level
       FROM runtime_config WHERE id = 'default'
       UNION ALL
       SELECT NULL, 'medium'
       WHERE NOT EXISTS (SELECT 1 FROM runtime_config WHERE id = 'default')
     )
     SELECT to_jsonb(model) AS model, settings.default_thinking_level,
       ${includeCredential ? '(SELECT secret_value FROM system_secrets WHERE key = model.api_key_secret_key) AS secret_value,' : ''}
       EXISTS (
         SELECT 1 FROM system_secrets
         WHERE key = model.api_key_secret_key AND secret_value <> ''
       ) AS has_secret
     FROM settings
     LEFT JOIN LATERAL (
       SELECT * FROM official_model_configs
       WHERE settings.default_official_model_id IS NULL
          OR id = settings.default_official_model_id
       ORDER BY enabled DESC, priority ASC, created_at ASC, id ASC
       LIMIT 1
     ) model ON true`,
  );
  return {
    model: rows[0].model,
    thinkingLevel: rows[0].default_thinking_level,
    hasSecret: rows[0].has_secret,
    ...(includeCredential ? { secretValue: rows[0].secret_value ?? null } : {}),
  };
}

export async function getPlatformModelSettings(): Promise<PlatformModelSettings> {
  return readPlatformModelSettings(getDbPool());
}

export async function getPlatformModelRuntimeSettings(): Promise<PlatformModelRuntimeSettings> {
  // One MVCC snapshot prevents sending a newly saved key to the previous provider URL.
  const settings = await readPlatformModelSettings(getDbPool(), true);
  return { ...settings, secretValue: settings.secretValue ?? null };
}

export interface PlatformModelConfigInput {
  piApi: ModelProviderType;
  baseUrl: string | null;
  modelName: string;
  secretValue?: string;
  authMode?: ModelAuthModeDto;
  contextWindowTokens: number | null;
  thinkingLevel: PiThinkingLevel;
  inputTokenPricePerMillionCoins: number;
  outputTokenPricePerMillionCoins: number;
  actor?: string;
}

export async function savePlatformModelConfig(
  input: PlatformModelConfigInput,
): Promise<PlatformModelSettings> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO runtime_config (id) VALUES ('default') ON CONFLICT (id) DO NOTHING",
    );
    // This row owns the only slot; concurrent first saves and updates share one boundary.
    await client.query(
      "SELECT id FROM runtime_config WHERE id = 'default' FOR UPDATE",
    );
    const current = await readPlatformModelSettings(client);
    const previous = current.model;
    const secretValue = input.secretValue?.trim();
    if (!secretValue && !current.hasSecret) {
      throw new ModelConfigurationError('请先配置官方模型的 API 密钥');
    }
    if (!secretValue && previous && previous.pi_api !== input.piApi) {
      throw new ModelConfigurationError('更换接口协议时，请填写新的 API 密钥');
    }
    const id = previous?.id ?? 'platform-model';
    const secretKey =
      previous?.api_key_secret_key ?? `official-model:${id}:secret`;
    if (secretValue) {
      await client.query(
        `INSERT INTO system_secrets (key, secret_value, updated_by, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (key) DO UPDATE SET
           secret_value = EXCLUDED.secret_value,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
        [secretKey, secretValue, input.actor ?? 'admin'],
      );
    }
    const defaultAuthMode =
      input.piApi === 'anthropic-messages'
        ? 'anthropic_api_key'
        : input.piApi === 'google-generative-ai'
          ? 'gemini_api_key'
          : 'openai_api_key';
    const extraJson = {
      auth_mode:
        input.authMode ??
        (previous?.pi_api === input.piApi
          ? previous.extra_json?.auth_mode
          : undefined) ??
        defaultAuthMode,
      context_window_tokens: input.contextWindowTokens,
    };
    await client.query(
      `INSERT INTO official_model_configs (
         id, model_key, pi_api, display_name, enabled, priority,
         base_url, model_name, api_key_secret_key,
         input_token_price_per_million_coins,
         output_token_price_per_million_coins, extra_json, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, true, 0, $5, $4, $6, $7, $8, $9, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         pi_api = EXCLUDED.pi_api,
         display_name = EXCLUDED.display_name,
         enabled = true,
         priority = 0,
         base_url = EXCLUDED.base_url,
         model_name = EXCLUDED.model_name,
         api_key_secret_key = EXCLUDED.api_key_secret_key,
         input_token_price_per_million_coins = EXCLUDED.input_token_price_per_million_coins,
         output_token_price_per_million_coins = EXCLUDED.output_token_price_per_million_coins,
         extra_json = EXCLUDED.extra_json,
         updated_at = NOW()`,
      [
        id,
        previous?.model_key ?? 'official',
        input.piApi,
        input.modelName,
        input.baseUrl,
        secretKey,
        input.inputTokenPricePerMillionCoins,
        input.outputTokenPricePerMillionCoins,
        JSON.stringify(extraJson),
      ],
    );
    await client.query(
      `UPDATE runtime_config SET
         default_official_model_id = $1,
         default_thinking_level = $2,
         updated_at = NOW()
       WHERE id = 'default'`,
      [id, input.thinkingLevel],
    );
    const updated = await readPlatformModelSettings(client);
    await client.query('COMMIT');
    return updated;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
