import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  getPlatformModelSettings: vi.fn(),
  getPlatformModelRuntimeSettings: vi.fn(),
  savePlatformModelConfig: vi.fn(),
  getRuntimeConfig: vi.fn(),
  getOfficialModelConfig: vi.fn(),
  listOfficialModelConfigs: vi.fn(),
  getSystemSecret: vi.fn(),
  getUserModelSelection: vi.fn(),
  getUserModelConfig: vi.fn(),
  getModelBillingConfig: vi.fn(),
  listConfigAuditLogs: vi.fn(),
}));

vi.mock('../../../src/infrastructure/db.js', () => db);

import {
  getSystemConfigOverview,
  listPublicOfficialModels,
  resolveUserLlmRuntime,
} from '../../../src/modules/system/system-config.js';

const model = {
  id: 'current-model',
  model_key: 'official',
  pi_api: 'openai-responses',
  display_name: 'Platform model',
  enabled: true,
  priority: 10,
  base_url: 'https://provider.example/v1',
  model_name: 'gpt-4.1',
  api_key_secret_key: 'test-model-secret',
  input_token_price_per_million_coins: 2,
  output_token_price_per_million_coins: 8,
  extra_json: {},
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.resetAllMocks();
  db.getPlatformModelRuntimeSettings.mockImplementation(async () => ({
    ...(await db.getPlatformModelSettings()),
    secretValue: 'synthetic-model-key',
  }));
  db.getPlatformModelSettings.mockResolvedValue({
    model,
    thinkingLevel: 'low',
    hasSecret: true,
  });
  db.getOfficialModelConfig.mockImplementation(async (id) =>
    id === model.id ? model : { ...model, id, model_key: 'legacy' },
  );
  db.listOfficialModelConfigs.mockResolvedValue([
    { ...model, id: 'legacy-model', model_key: 'legacy', priority: 0 },
    model,
  ]);
  db.getSystemSecret.mockResolvedValue({ secret_value: 'synthetic-test-key' });
  db.getUserModelConfig.mockResolvedValue({
    ...model,
    user_id: 'user',
    model_name: 'user-model',
  });
  db.getModelBillingConfig.mockResolvedValue({
    custom_model_platform_price_per_million_coins: 2,
  });
  db.listConfigAuditLogs.mockResolvedValue([]);
});

describe('single platform model', () => {
  it.each(['custom', 'official'])(
    'ignores legacy %s user choices and thinking levels',
    async (source) => {
      db.getUserModelSelection.mockResolvedValue({
        user_id: 'user',
        source,
        official_model_id: 'legacy-model',
        thinking_level: 'xhigh',
      });

      const runtime = await resolveUserLlmRuntime('user');

      expect(runtime).toMatchObject({
        source: 'official',
        modelConfigId: model.id,
        thinkingLevel: 'low',
        model: model.model_name,
      });
      expect(db.getUserModelSelection).not.toHaveBeenCalled();
      expect(db.getUserModelConfig).not.toHaveBeenCalled();
    },
  );

  it('fails when the configured model is unavailable instead of selecting another model', async () => {
    db.getPlatformModelSettings.mockResolvedValue({
      model: { ...model, enabled: false },
      thinkingLevel: 'low',
      hasSecret: true,
    });

    await expect(resolveUserLlmRuntime('user')).rejects.toThrow();
  });

  it('publishes only the configured model', async () => {
    expect(await listPublicOfficialModels()).toEqual([
      { model_key: 'official', display_name: 'Platform model' },
    ]);
  });

  it('returns a single admin slot without fee, runtime policy, or audit settings', async () => {
    const overview = await getSystemConfigOverview();

    expect(Object.keys(overview).sort()).toEqual(['model', 'thinking_level']);
    expect(overview).toMatchObject({
      model: { id: model.id, has_secret: true },
      thinking_level: 'low',
    });
    expect(db.getModelBillingConfig).not.toHaveBeenCalled();
    expect(db.listConfigAuditLogs).not.toHaveBeenCalled();
  });
});
