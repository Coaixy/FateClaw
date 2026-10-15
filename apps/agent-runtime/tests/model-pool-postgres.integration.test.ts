import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { RuntimeModelPoolNode } from '@fateclaw/contracts/model-settings';

const state = vi.hoisted(() => ({ pool: null as pg.Pool | null }));
vi.mock('../src/agent-db.js', () => ({ getAgentDbPool: () => state.pool }));
vi.mock('../../api/src/infrastructure/db-pool.js', () => ({
  getDbPool: () => state.pool,
}));
import { databaseModelPoolHealth } from '../src/model-pool-health.js';
import { MIGRATIONS } from '../../api/src/infrastructure/migrations/manifest.js';
import { officialModelPoolMigration } from '../../api/src/infrastructure/migrations/versions/0083-official-model-pool.js';
import { officialModelPoolPrimaryMigration } from '../../api/src/infrastructure/migrations/versions/0084-official-model-pool-primary.js';
import {
  getPlatformModelRuntimeSettings,
  getPlatformModelSettings,
  savePlatformModelConfig,
} from '../../api/src/infrastructure/repositories/config-repository.js';

// Only the explicitly supplied disposable server is used, never the application's DATABASE_URL.
const connectionString = process.env.FATECLAW_TEST_MODEL_POOL_DATABASE_URL;
const node: RuntimeModelPoolNode = {
  modelConfigId: 'legacy-active',
  revision: 1,
  weight: 1,
  piApi: 'openai-completions',
  model: 'synthetic-model',
  providerKey: 'existing-alias',
  authMode: 'openai_api_key',
  apiKey: 'synthetic-value-a',
};
const inputNode = {
  id: node.modelConfigId,
  displayName: 'Provider A',
  piApi: 'openai-completions' as const,
  modelName: node.model,
  baseUrl: null,
  contextWindowTokens: null,
  enabled: true,
  weight: 1,
};
const input = {
  displayName: 'Pool',
  thinkingLevel: 'medium' as const,
  inputTokenPricePerMillionCoins: 2,
  outputTokenPricePerMillionCoins: 8,
  nodes: [inputNode],
};

describe.skipIf(!connectionString)('model pool PostgreSQL integration', () => {
  let admin: pg.Pool;
  let databaseName: string;
  let migrated: Awaited<ReturnType<typeof getPlatformModelSettings>>;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString });
    databaseName = `fateclaw_pool_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(connectionString!);
    url.pathname = `/${databaseName}`;
    state.pool = new pg.Pool({
      connectionString: url.toString(),
      max: 6,
      connectionTimeoutMillis: 5000,
    });
    const client = await state.pool.connect();
    try {
      for (const migration of MIGRATIONS) {
        if (migration.id === officialModelPoolMigration.id) break;
        await migration.up(client);
      }
      await client.query(`INSERT INTO official_model_configs
        (id, model_key, pi_api, display_name, model_name, api_key_secret_key,
          input_token_price_per_million_coins, output_token_price_per_million_coins)
        VALUES ('legacy-active','existing-alias','openai-completions','Provider A','synthetic-model','synthetic-key-ref',2,8),
          ('legacy-unused','old-unused','openai-completions','Unused','unused-model',NULL,0,0)`);
      await client.query(
        `INSERT INTO system_secrets (key,secret_value) VALUES ('synthetic-key-ref','synthetic-value-a')`,
      );
      await client.query(
        `UPDATE runtime_config SET default_official_model_id='legacy-active',default_thinking_level='high' WHERE id='default'`,
      );
      await officialModelPoolMigration.up(client);
      await officialModelPoolPrimaryMigration.up(client);
      migrated = await getPlatformModelSettings();
    } finally {
      client.release();
    }
  }, 30_000);
  beforeEach(async () => {
    await state.pool!.query(
      'UPDATE official_model_pool_settings SET primary_node_id=NULL',
    );
    await state.pool!.query('DELETE FROM official_model_pool_nodes');
    await state.pool!.query(
      "INSERT INTO official_model_pool_nodes (model_config_id) VALUES ('legacy-active')",
    );
    await state.pool!.query(
      "UPDATE official_model_pool_settings SET primary_node_id='legacy-active'",
    );
    await state.pool!.query(
      "UPDATE official_model_configs SET enabled=true,model_name='synthetic-model',base_url=NULL,extra_json='{}'::jsonb WHERE id='legacy-active'",
    );
  });
  afterAll(async () => {
    await state.pool?.end();
    state.pool = null;
    if (databaseName) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin?.end();
  });

  it('migrates only the configured node while preserving the alias, public prices and credential reference', () => {
    expect(migrated.pool).toMatchObject({
      public_model_id: 'legacy-active',
      primary_node_id: 'legacy-active',
      model_key: 'existing-alias',
      thinking_level: 'high',
      input_token_price_per_million_coins: 2,
      output_token_price_per_million_coins: 8,
    });
    expect(migrated.nodes.map((entry) => entry.model.id)).toEqual([
      'legacy-active',
    ]);
    expect(JSON.stringify(migrated)).not.toContain('synthetic-value-a');
  });

  it('retains the primary through child edits and deletion, including reordered submissions and direct deletion attempts', async () => {
    await savePlatformModelConfig({
      ...input,
      nodes: [
        inputNode,
        {
          ...inputNode,
          id: undefined,
          displayName: 'Child',
          modelName: 'child-model',
          secretValue: 'synthetic-child-key',
        },
      ],
    });
    const childId = (await getPlatformModelSettings()).nodes.find(
      (entry) => entry.model.id !== node.modelConfigId,
    )!.model.id;
    await savePlatformModelConfig({
      ...input,
      nodes: [
        { ...inputNode, id: childId, displayName: 'Edited child', weight: 3 },
        inputNode,
      ],
    });
    expect((await getPlatformModelSettings()).pool.primary_node_id).toBe(
      node.modelConfigId,
    );
    await expect(
      savePlatformModelConfig({
        ...input,
        nodes: [{ ...inputNode, id: childId }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      state.pool!.query(
        'DELETE FROM official_model_pool_nodes WHERE model_config_id=$1',
        [node.modelConfigId],
      ),
    ).rejects.toMatchObject({ code: '23001' });
    await savePlatformModelConfig(input);
    const remaining = await getPlatformModelSettings();
    expect(remaining.nodes.map((entry) => entry.model.id)).toEqual([
      node.modelConfigId,
    ]);
    expect(remaining.pool.primary_node_id).toBe(node.modelConfigId);
  });

  it('establishes the first saved node as primary on an unconfigured installation', async () => {
    await state.pool!.query(
      'UPDATE official_model_pool_settings SET primary_node_id=NULL',
    );
    await state.pool!.query('DELETE FROM official_model_pool_nodes');
    const saved = await savePlatformModelConfig({
      ...input,
      nodes: [
        {
          ...inputNode,
          id: undefined,
          displayName: 'New primary',
          secretValue: 'synthetic-initial-key',
        },
      ],
    });
    expect(saved.pool.primary_node_id).toBe(saved.nodes[0].model.id);
  });

  it('persists mixed-model nodes and keeps metadata reads free of credential values', async () => {
    await savePlatformModelConfig({
      ...input,
      nodes: [
        inputNode,
        {
          ...inputNode,
          id: undefined,
          displayName: 'Provider B',
          piApi: 'anthropic-messages',
          modelName: 'synthetic-other-model',
          secretValue: 'synthetic-value-b',
          weight: 3,
        },
      ],
    });
    const metadata = await getPlatformModelSettings();
    expect(metadata.nodes).toHaveLength(2);
    expect(JSON.stringify(metadata)).not.toContain('synthetic-value-');
    expect(
      (await getPlatformModelRuntimeSettings()).nodes
        .map((entry) => entry.secretValue)
        .sort(),
    ).toEqual(['synthetic-value-a', 'synthetic-value-b']);
  });

  it('serializes concurrent configuration writers without mixing node weights and common prices', async () => {
    await Promise.all(
      [1, 2].map((value) =>
        savePlatformModelConfig({
          ...input,
          displayName: `Writer ${value}`,
          inputTokenPricePerMillionCoins: value,
          nodes: [{ ...inputNode, weight: value }],
        }),
      ),
    );
    const saved = await getPlatformModelSettings();
    const value = Number(saved.pool.display_name.slice(-1));
    expect(saved.pool.input_token_price_per_million_coins).toBe(value);
    expect(saved.nodes[0].weight).toBe(value);
  });

  it('shares cooldowns, allows exactly one recovery probe, and ignores stale results after recovery', async () => {
    const first = await databaseModelPoolHealth.claim(node, 'first');
    const late = await databaseModelPoolHealth.claim(node, 'late');
    expect(first).not.toBeNull();
    await databaseModelPoolHealth.finish(node, first!, 'failure');
    expect(await databaseModelPoolHealth.claim(node, 'cooling')).toBeNull();
    await state.pool!.query(
      "UPDATE official_model_pool_nodes SET cooldown_until=now()-interval '1 second'",
    );
    const probes = await Promise.all(
      ['probe-a', 'probe-b'].map((token) =>
        databaseModelPoolHealth.claim(node, token),
      ),
    );
    expect(probes.filter(Boolean)).toHaveLength(1);
    await databaseModelPoolHealth.finish(
      node,
      probes.find(Boolean)!,
      'success',
    );
    await databaseModelPoolHealth.finish(node, late!, 'failure');
    const current = await state.pool!.query(
      'SELECT failure_count,health_generation,cooldown_until FROM official_model_pool_nodes',
    );
    expect(current.rows[0]).toMatchObject({
      failure_count: 0,
      health_generation: 2,
      cooldown_until: null,
    });
  });

  it('backs off failed probes and releases cancelled probes for another bounded attempt', async () => {
    const first = await databaseModelPoolHealth.claim(node, 'first');
    await databaseModelPoolHealth.finish(node, first!, 'failure');
    await state.pool!.query(
      "UPDATE official_model_pool_nodes SET cooldown_until=now()-interval '1 second'",
    );
    const cancelled = await databaseModelPoolHealth.claim(node, 'cancelled');
    await databaseModelPoolHealth.finish(node, cancelled!, 'release');
    const next = await databaseModelPoolHealth.claim(node, 'next');
    expect(next).not.toBeNull();
    await databaseModelPoolHealth.finish(node, next!, 'failure');
    const result = await state.pool!.query(
      'SELECT failure_count,EXTRACT(EPOCH FROM cooldown_until-now()) AS seconds FROM official_model_pool_nodes',
    );
    expect(result.rows[0].failure_count).toBe(2);
    expect(Number(result.rows[0].seconds)).toBeGreaterThan(59);
    expect(Number(result.rows[0].seconds)).toBeLessThanOrEqual(60);
  });

  it('rejects an old request revision and ignores its health report after a configuration change', async () => {
    const old = await databaseModelPoolHealth.claim(node, 'old');
    await savePlatformModelConfig({
      ...input,
      nodes: [{ ...inputNode, secretValue: 'synthetic-rotated-value' }],
    });
    expect(await databaseModelPoolHealth.claim(node, 'old-again')).toBeNull();
    await databaseModelPoolHealth.finish(node, old!, 'failure');
    const updated = await getPlatformModelSettings();
    expect(updated.nodes[0]).toMatchObject({
      revision: 2,
      failureCount: 0,
      cooldownUntil: null,
    });
  });
});
