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
  id: 'existing-slot',
  model_key: 'existing-alias',
  pi_api: 'openai-responses',
  model_name: 'gpt-4.1',
  api_key_secret_key: 'existing-key-ref',
  extra_json: {},
};
const snapshot = { model, default_thinking_level: 'medium', has_secret: true };
const input = {
  piApi: 'openai-responses' as const,
  baseUrl: null,
  modelName: 'gpt-4.1',
  contextWindowTokens: null,
  thinkingLevel: 'low' as const,
  inputTokenPricePerMillionCoins: 2,
  outputTokenPricePerMillionCoins: 8,
};

type SettingsRow = {
  model: typeof model | null;
  default_thinking_level: string;
  has_secret: boolean;
};
function poolWithSnapshots(
  current: SettingsRow = snapshot,
  updated: SettingsRow = { ...snapshot, default_thinking_level: 'low' },
) {
  let reads = 0;
  const query = vi.fn(async (sql: string, _params?: unknown[]) => ({
    rows: sql.startsWith('WITH settings')
      ? [reads++ === 0 ? current : updated]
      : [],
  }));
  const release = vi.fn();
  getPool.mockReturnValue({ query, connect: async () => ({ query, release }) });
  return { query, release };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('platform model repository', () => {
  it('keeps credential values out of metadata reads', async () => {
    const query = vi.fn(async (_sql: string) => ({
      rows: [{ ...snapshot, secret_value: 'synthetic-key' }],
    }));
    getPool.mockReturnValue({ query });
    expect(await getPlatformModelSettings()).toEqual({
      model,
      thinkingLevel: 'medium',
      hasSecret: true,
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).not.toContain('AS secret_value');
  });

  it('reads connection settings and credentials in one statement for runtime use', async () => {
    const query = vi.fn(async (_sql: string) => ({
      rows: [{ ...snapshot, secret_value: 'synthetic-key' }],
    }));
    getPool.mockReturnValue({ query });
    expect(await getPlatformModelRuntimeSettings()).toEqual({
      model,
      thinkingLevel: 'medium',
      hasSecret: true,
      secretValue: 'synthetic-key',
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it('updates the existing slot and preserves its credential when the key is omitted', async () => {
    const { query, release } = poolWithSnapshots();
    expect(await savePlatformModelConfig(input)).toMatchObject({
      model,
      thinkingLevel: 'low',
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'));
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO system_secrets'),
      expect.anything(),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO official_model_configs'),
      expect.arrayContaining([
        model.id,
        model.model_key,
        model.api_key_secret_key,
      ]),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE runtime_config'),
      [model.id, 'low'],
    );
    expect(query).toHaveBeenLastCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('creates the only slot on first save and returns the committed configuration', async () => {
    const current = {
      model: null,
      default_thinking_level: 'medium',
      has_secret: false,
    };
    const updated = {
      model: { ...model, id: 'platform-model', model_key: 'official' },
      default_thinking_level: 'low',
      has_secret: true,
    };
    const { query } = poolWithSnapshots(current, updated);
    expect(
      await savePlatformModelConfig({ ...input, secretValue: 'synthetic-key' }),
    ).toMatchObject({ model: { id: 'platform-model' }, thinkingLevel: 'low' });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE runtime_config'),
      ['platform-model', 'low'],
    );
    expect(query).toHaveBeenLastCalledWith('COMMIT');
  });

  it('rejects first configuration without a key and releases the transaction', async () => {
    const { query, release } = poolWithSnapshots({
      ...snapshot,
      model: null,
      has_secret: false,
    });
    await expect(savePlatformModelConfig(input)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO official_model_configs'),
      expect.anything(),
    );
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });

  it('requires a new key before changing provider protocol', async () => {
    const { query } = poolWithSnapshots();
    await expect(
      savePlatformModelConfig({ ...input, piApi: 'anthropic-messages' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('rolls back and propagates a database failure after a credential update', async () => {
    const { query, release } = poolWithSnapshots();
    const normalQuery = query.getMockImplementation()!;
    const failure = new Error('Synthetic database failure');
    query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('UPDATE runtime_config')) throw failure;
      return normalQuery(sql, params);
    });
    await expect(
      savePlatformModelConfig({ ...input, secretValue: 'synthetic-key' }),
    ).rejects.toBe(failure);
    expect(query).not.toHaveBeenCalledWith('COMMIT');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});
