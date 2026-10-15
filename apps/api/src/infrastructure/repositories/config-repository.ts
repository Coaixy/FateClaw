import { randomUUID } from 'node:crypto';
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

export interface PlatformModelPool {
  primary_node_id: string | null;
  public_model_id: string;
  model_key: string;
  display_name: string;
  thinking_level: PiThinkingLevel;
  input_token_price_per_million_coins: number;
  output_token_price_per_million_coins: number;
}

export interface PlatformModelNode {
  model: OfficialModelConfig;
  weight: number;
  revision: number;
  hasSecret: boolean;
  failureCount: number;
  cooldownUntil: string | null;
}

export interface PlatformModelSettings {
  pool: PlatformModelPool;
  nodes: PlatformModelNode[];
}

export interface PlatformModelRuntimeSettings extends PlatformModelSettings {
  nodes: Array<PlatformModelNode & { secretValue: string | null }>;
}

async function readPlatformModelSettings(
  db: DbQueryable,
  includeCredential = false,
): Promise<PlatformModelRuntimeSettings> {
  const { rows } = await db.query<{
    pool: PlatformModelPool;
    nodes: PlatformModelRuntimeSettings['nodes'];
  }>(
    `SELECT to_jsonb(pool) AS pool, COALESCE((
       SELECT jsonb_agg(jsonb_build_object(
         'model', to_jsonb(model), 'weight', node.weight, 'revision', node.revision,
         'failureCount', node.failure_count, 'cooldownUntil', node.cooldown_until,
         ${includeCredential ? "'secretValue', (SELECT secret_value FROM system_secrets WHERE key = model.api_key_secret_key)," : ''}
         'hasSecret', EXISTS (SELECT 1 FROM system_secrets
           WHERE key = model.api_key_secret_key AND secret_value <> '')
       ) ORDER BY (model.id = pool.primary_node_id) DESC, model.created_at, model.id)
       FROM official_model_pool_nodes node
       JOIN official_model_configs model ON model.id = node.model_config_id
     ), '[]'::jsonb) AS nodes
     FROM official_model_pool_settings pool WHERE pool.id = 'default'`,
  );
  if (!rows[0]) throw new Error('Official model pool migration is missing');
  return rows[0];
}

export async function getPlatformModelSettings(): Promise<PlatformModelSettings> {
  return readPlatformModelSettings(getDbPool());
}

export async function getPlatformModelRuntimeSettings(): Promise<PlatformModelRuntimeSettings> {
  // Connection settings and every credential come from one MVCC snapshot.
  return readPlatformModelSettings(getDbPool(), true);
}

export interface PlatformModelNodeInput {
  id?: string;
  displayName: string;
  piApi: ModelProviderType;
  baseUrl: string | null;
  modelName: string;
  secretValue?: string;
  authMode?: ModelAuthModeDto;
  contextWindowTokens: number | null;
  enabled: boolean;
  weight: number;
}

export interface PlatformModelConfigInput {
  displayName: string;
  thinkingLevel: PiThinkingLevel;
  inputTokenPricePerMillionCoins: number;
  outputTokenPricePerMillionCoins: number;
  nodes: PlatformModelNodeInput[];
  actor?: string;
}

function defaultAuthMode(piApi: ModelProviderType): ModelAuthModeDto {
  return piApi === 'anthropic-messages'
    ? 'anthropic_api_key'
    : piApi === 'google-generative-ai'
      ? 'gemini_api_key'
      : 'openai_api_key';
}

export async function savePlatformModelConfig(
  input: PlatformModelConfigInput,
): Promise<PlatformModelSettings> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    // All pool membership, connection and price changes have one writer boundary.
    await client.query(
      "SELECT id FROM official_model_pool_settings WHERE id = 'default' FOR UPDATE",
    );
    const current = await readPlatformModelSettings(client);
    if (!input.nodes.length) throw new ModelConfigurationError('请配置主节点');
    if (
      current.pool.primary_node_id &&
      !input.nodes.some((node) => node.id === current.pool.primary_node_id)
    ) {
      throw new ModelConfigurationError(
        '主节点必须保留，可以编辑配置，不能删除',
      );
    }
    let primaryNodeId = current.pool.primary_node_id;
    const retainedIds: string[] = [];
    for (const node of input.nodes) {
      const previous = current.nodes.find(
        (entry) => entry.model.id === node.id,
      );
      if (node.id && !previous)
        throw new ModelConfigurationError('模型节点不存在，请刷新后重试');
      const id = previous?.model.id ?? randomUUID();
      if (retainedIds.includes(id))
        throw new ModelConfigurationError('模型节点不能重复');
      retainedIds.push(id);
      primaryNodeId ??= id;
      const secretValue = node.secretValue?.trim();
      if (node.enabled && !secretValue && !previous?.hasSecret) {
        throw new ModelConfigurationError('启用模型节点前，请先配置 API 密钥');
      }
      const authMode =
        node.authMode ??
        (previous?.model.pi_api === node.piApi
          ? previous.model.extra_json?.auth_mode
          : undefined) ??
        defaultAuthMode(node.piApi);
      const connectionChanged =
        previous &&
        (previous.model.pi_api !== node.piApi ||
          previous.model.base_url !== node.baseUrl ||
          (previous.model.extra_json?.auth_mode ??
            defaultAuthMode(previous.model.pi_api)) !== authMode);
      if (!secretValue && previous?.hasSecret && connectionChanged) {
        throw new ModelConfigurationError(
          '更换接口协议、地址或认证方式时，请填写新的 API 密钥',
        );
      }
      const secretKey =
        previous?.model.api_key_secret_key ?? `official-model:${id}:secret`;
      if (secretValue) {
        await client.query(
          `INSERT INTO system_secrets (key, secret_value, updated_by, updated_at)
           VALUES ($1, $2, $3, NOW()) ON CONFLICT (key) DO UPDATE SET
           secret_value = EXCLUDED.secret_value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
          [secretKey, secretValue, input.actor ?? 'admin'],
        );
      }
      const extraJson = {
        ...previous?.model.extra_json,
        auth_mode: authMode,
        context_window_tokens: node.contextWindowTokens,
      };
      await client.query(
        `INSERT INTO official_model_configs (
           id, model_key, pi_api, display_name, enabled, priority, base_url, model_name,
           api_key_secret_key, input_token_price_per_million_coins,
           output_token_price_per_million_coins, extra_json, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11,NOW(),NOW())
         ON CONFLICT (id) DO UPDATE SET pi_api=EXCLUDED.pi_api, display_name=EXCLUDED.display_name,
           enabled=EXCLUDED.enabled, base_url=EXCLUDED.base_url, model_name=EXCLUDED.model_name,
           api_key_secret_key=EXCLUDED.api_key_secret_key, extra_json=EXCLUDED.extra_json, updated_at=NOW()`,
        [
          id,
          previous?.model.model_key ?? `pool-node-${id}`,
          node.piApi,
          node.displayName,
          node.enabled,
          node.baseUrl,
          node.modelName,
          secretKey,
          input.inputTokenPricePerMillionCoins,
          input.outputTokenPricePerMillionCoins,
          JSON.stringify(extraJson),
        ],
      );
      const resetHealth = Boolean(
        secretValue ||
        connectionChanged ||
        (previous &&
          (previous.model.model_name !== node.modelName ||
            previous.model.enabled !== node.enabled ||
            previous.model.extra_json?.context_window_tokens !==
              node.contextWindowTokens)),
      );
      await client.query(
        `INSERT INTO official_model_pool_nodes (model_config_id, weight) VALUES ($1,$2)
         ON CONFLICT (model_config_id) DO UPDATE SET weight=EXCLUDED.weight,
           revision=official_model_pool_nodes.revision + CASE WHEN $3 THEN 1 ELSE 0 END,
           health_generation=official_model_pool_nodes.health_generation + CASE WHEN $3 THEN 1 ELSE 0 END,
           failure_count=CASE WHEN $3 THEN 0 ELSE official_model_pool_nodes.failure_count END,
           cooldown_until=CASE WHEN $3 THEN NULL ELSE official_model_pool_nodes.cooldown_until END,
           probe_until=CASE WHEN $3 THEN NULL ELSE official_model_pool_nodes.probe_until END,
           probe_token=CASE WHEN $3 THEN NULL ELSE official_model_pool_nodes.probe_token END`,
        [id, node.weight, resetHealth],
      );
    }
    // Historical model rows and their credential references remain available to billing records.
    await client.query(
      'DELETE FROM official_model_pool_nodes WHERE NOT (model_config_id = ANY($1::text[]))',
      [retainedIds],
    );
    await client.query(
      `UPDATE official_model_pool_settings SET display_name=$1, thinking_level=$2,
         input_token_price_per_million_coins=$3, output_token_price_per_million_coins=$4,
         primary_node_id=$5, updated_at=NOW()
       WHERE id='default'`,
      [
        input.displayName,
        input.thinkingLevel,
        input.inputTokenPricePerMillionCoins,
        input.outputTokenPricePerMillionCoins,
        primaryNodeId,
      ],
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
