import { beforeEach, describe, expect, it, vi } from 'vitest';
const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }));
vi.mock('../../../src/infrastructure/db-pool.js', () => ({
  getDbPool: getPool,
}));
import {
  getPlatformModelRuntimeSettings,
  getPlatformModelSettings,
  savePlatformModelConfig,
} from '../../../src/infrastructure/repositories/config-repository.js';

const model = {
  id: 'node-a',
  model_key: 'provider-a',
  display_name: 'Provider A',
  enabled: true,
  pi_api: 'openai-responses',
  base_url: null,
  model_name: 'gpt-4.1',
  api_key_secret_key: 'synthetic-key-ref',
  extra_json: { context_window_tokens: null },
};
const snapshot = {
  pool: {
    primary_node_id: model.id,
    public_model_id: 'official',
    model_key: 'official',
    display_name: 'Pool',
    thinking_level: 'medium',
    input_token_price_per_million_coins: 2,
    output_token_price_per_million_coins: 8,
  },
  nodes: [
    {
      model,
      weight: 1,
      revision: 1,
      hasSecret: true,
      failureCount: 0,
      cooldownUntil: null,
    },
  ],
};
const nodeInput = {
  id: model.id,
  displayName: model.display_name,
  piApi: 'openai-responses' as const,
  baseUrl: null,
  modelName: 'gpt-4.1',
  contextWindowTokens: null,
  enabled: true,
  weight: 2,
};
const input = {
  displayName: 'Pool',
  thinkingLevel: 'low' as const,
  inputTokenPricePerMillionCoins: 2,
  outputTokenPricePerMillionCoins: 8,
  nodes: [nodeInput],
};
function poolWithSnapshots(current: unknown = snapshot) {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
    rows: [current],
  }));
  const release = vi.fn();
  getPool.mockReturnValue({ query, connect: async () => ({ query, release }) });
  return { query, release };
}
beforeEach(() => vi.resetAllMocks());

describe('model pool repository', () => {
  it('rejects deleting the primary node even when a child node remains', async () => {
    const child = { ...snapshot.nodes[0], model: { ...model, id: 'node-b' } };
    const { query } = poolWithSnapshots({
      ...snapshot,
      pool: { ...snapshot.pool, primary_node_id: model.id },
      nodes: [...snapshot.nodes, child],
    });
    await expect(
      savePlatformModelConfig({
        ...input,
        nodes: [{ ...nodeInput, id: child.model.id }],
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: '主节点必须保留，可以编辑配置，不能删除',
    });
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO system_secrets'),
      expect.anything(),
    );
  });

  it('uses metadata-only reads and one MVCC snapshot for all runtime connections and credentials', async () => {
    const { query } = poolWithSnapshots();
    expect(await getPlatformModelSettings()).toEqual(snapshot);
    expect(query.mock.calls[0][0]).not.toContain("'secretValue'");
    await getPlatformModelRuntimeSettings();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain("'secretValue'");
  });
  it('locks the pool, preserves omitted keys and commits all node and price updates together', async () => {
    const { query, release } = poolWithSnapshots();
    await savePlatformModelConfig(input);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), [
      'default',
    ]);
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO system_secrets'),
      expect.anything(),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO official_model_pool_nodes'),
      [model.id, 2, false, 'default', null],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE official_model_pool_settings'),
      ['Pool', 'low', 2, 8, model.id, 'default', true, null],
    );
    expect(query).toHaveBeenLastCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });
  it('adds a node with its own credential reference and retains only submitted membership', async () => {
    const { query } = poolWithSnapshots();
    await savePlatformModelConfig({
      ...input,
      nodes: [
        ...input.nodes,
        {
          ...nodeInput,
          id: undefined,
          displayName: 'Provider B',
          modelName: 'other-model',
          secretValue: 'synthetic-new-key',
        },
      ],
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO system_secrets'),
      [expect.stringMatching(/^official-model:/), 'synthetic-new-key', 'admin'],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM official_model_pool_nodes'),
      [[model.id, expect.any(String)], 'default'],
    );
  });
  it.each([
    { piApi: 'anthropic-messages' as const },
    { baseUrl: 'https://other.example/v1' },
    { authMode: 'claude_code_oauth_token' as const },
  ])(
    'requires a new key when a credential destination or authentication changes',
    async (patch) => {
      const { query } = poolWithSnapshots();
      await expect(
        savePlatformModelConfig({
          ...input,
          nodes: [{ ...nodeInput, ...patch }],
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    },
  );
  it('rejects a node that was removed by another writer', async () => {
    const { query } = poolWithSnapshots();
    await expect(
      savePlatformModelConfig({
        ...input,
        nodes: [nodeInput, { ...nodeInput, id: 'removed' }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('preserves a saved OAuth mode when an unchanged node omits the optional auth mode', async () => {
    const { query } = poolWithSnapshots({
      ...snapshot,
      nodes: [
        {
          ...snapshot.nodes[0],
          model: {
            ...model,
            pi_api: 'anthropic-messages',
            extra_json: {
              auth_mode: 'claude_code_oauth_token',
              context_window_tokens: null,
            },
          },
        },
      ],
    });
    await savePlatformModelConfig({
      ...input,
      nodes: [{ ...nodeInput, piApi: 'anthropic-messages' }],
    });
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO system_secrets'),
      expect.anything(),
    );
    expect(query).toHaveBeenLastCalledWith('COMMIT');
  });
  it('rejects enabling an unconfigured node without a key', async () => {
    poolWithSnapshots({
      ...snapshot,
      pool: { ...snapshot.pool, primary_node_id: null },
      nodes: [],
    });
    await expect(
      savePlatformModelConfig({
        ...input,
        nodes: [{ ...nodeInput, id: undefined }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
  it('rolls back connection, credential and membership changes if saving common prices fails', async () => {
    const { query, release } = poolWithSnapshots();
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (sql, params) => {
      if (sql.includes('UPDATE official_model_pool_settings'))
        throw new Error('Synthetic failure');
      return original(sql, params);
    });
    await expect(
      savePlatformModelConfig({
        ...input,
        nodes: [{ ...nodeInput, secretValue: 'synthetic-key' }],
      }),
    ).rejects.toThrow('Synthetic failure');
    expect(query).not.toHaveBeenCalledWith('COMMIT');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});
