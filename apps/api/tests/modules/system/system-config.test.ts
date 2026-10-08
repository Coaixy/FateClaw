import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  getPlatformModelSettings: vi.fn(),
  getPlatformModelRuntimeSettings: vi.fn(),
  getSystemSecret: vi.fn(),
  savePlatformModelConfig: vi.fn(),
}));
vi.mock('../../../src/infrastructure/db.js', () => db);

import {
  getAgentConcurrencyLimit,
  getLocalAgentRuntimePolicy,
  getPiSessionHealthPolicy,
  getSkillBundleLimitsPolicy,
  getSystemConfigOverview,
  getUserModelSettingsOverview,
  getUserSkillLimitPolicy,
  listPublicOfficialModels,
  resolveOfficialRuntimeByModelKey,
  resolveUserLlmRuntime,
  saveOfficialModelSettings,
} from '../../../src/modules/system/system-config.js';
import type { OfficialModelConfig } from '../../../src/shared/types.js';

const model: OfficialModelConfig = {
  id: 'model-slot',
  model_key: 'official',
  pi_api: 'openai-responses',
  display_name: 'Official model',
  enabled: true,
  priority: 0,
  base_url: null,
  model_name: 'gpt-4.1',
  api_key_secret_key: 'test-key-ref',
  input_token_price_per_million_coins: 2,
  output_token_price_per_million_coins: 8,
  extra_json: { context_window_tokens: 256_000 },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};
const settings = { model, thinkingLevel: 'high', hasSecret: true };
const update = {
  pi_api: 'openai-responses' as const,
  base_url: null,
  model_name: 'gpt-4.1',
  context_window_tokens: null,
  thinking_level: 'low' as const,
  input_token_price_per_million_coins: 2,
  output_token_price_per_million_coins: 8,
};

beforeEach(() => {
  vi.resetAllMocks();
  db.getPlatformModelRuntimeSettings.mockImplementation(async () => ({
    ...(await db.getPlatformModelSettings()),
    secretValue: 'synthetic-model-key',
  }));
  db.getPlatformModelSettings.mockResolvedValue(settings);
  db.getSystemSecret.mockResolvedValue({ secret_value: 'synthetic-model-key' });
  db.savePlatformModelConfig.mockResolvedValue(settings);
});

describe('official model runtime', () => {
  it('uses the configured context window and token pricing', async () => {
    expect(await resolveUserLlmRuntime('user')).toMatchObject({
      source: 'official',
      billingMode: 'metered',
      contextWindowTokens: 256_000,
      thinkingLevel: 'high',
      inputTokenPricePerMillionCoins: 2,
      outputTokenPricePerMillionCoins: 8,
    });
  });

  it('resolves connection settings and credentials from one database snapshot', async () => {
    db.getPlatformModelRuntimeSettings.mockResolvedValue({
      ...settings,
      secretValue: 'synthetic-original-key',
    });
    db.getSystemSecret.mockResolvedValue({
      secret_value: 'synthetic-rotated-key',
    });
    expect(await resolveUserLlmRuntime('user')).toMatchObject({
      secret: 'synthetic-original-key',
    });
    expect(db.getSystemSecret).not.toHaveBeenCalled();
  });

  it('accepts only the current model alias, or an omitted alias', async () => {
    expect(await resolveOfficialRuntimeByModelKey('official')).toMatchObject({
      modelConfigId: model.id,
    });
    expect(await resolveOfficialRuntimeByModelKey()).toMatchObject({
      modelConfigId: model.id,
    });
    expect(await resolveOfficialRuntimeByModelKey('legacy')).toBeNull();
  });

  it('uses the platform default when a historical thinking value is invalid', async () => {
    db.getPlatformModelSettings.mockResolvedValue({
      ...settings,
      thinkingLevel: 'unknown',
    });
    expect(await resolveUserLlmRuntime('user')).toMatchObject({
      thinkingLevel: 'medium',
    });
  });

  it('preserves the configured Anthropic OAuth authentication', async () => {
    db.getPlatformModelSettings.mockResolvedValue({
      ...settings,
      model: {
        ...model,
        pi_api: 'anthropic-messages',
        extra_json: { auth_mode: 'claude_code_oauth_token' },
      },
    });
    expect(await resolveUserLlmRuntime('user')).toMatchObject({
      authMode: 'claude_code_oauth_token',
    });
  });

  it.each([
    { model: null, hasSecret: false },
    { model: { ...model, enabled: false }, hasSecret: true },
    { model: { ...model, model_name: ' ' }, hasSecret: true },
    { model, hasSecret: false },
  ])('fails explicitly when the single slot cannot run', async (overrides) => {
    db.getPlatformModelSettings.mockResolvedValue({
      ...settings,
      ...overrides,
    });
    await expect(resolveUserLlmRuntime('user')).rejects.toThrow(
      '官方模型暂不可用',
    );
    expect(await listPublicOfficialModels()).toEqual([]);
    expect(db.getSystemSecret).not.toHaveBeenCalled();
  });

  it('handles a missing credential without falling back to another model', async () => {
    db.getPlatformModelRuntimeSettings.mockResolvedValue({
      ...settings,
      secretValue: null,
    });
    await expect(resolveUserLlmRuntime('user')).rejects.toThrow(
      '官方模型暂不可用',
    );
  });
});

describe('configuration views', () => {
  it('returns user-visible model information without connection or credential metadata', async () => {
    const overview = await getUserModelSettingsOverview('user');
    expect(overview).toMatchObject({
      model: { id: model.id, has_secret: true },
    });
    expect(Object.keys(overview)).toEqual(['model']);
    for (const field of [
      'api_key',
      'api_key_preview',
      'api_key_fingerprint',
      'api_key_secret_key',
      'extra_json',
      'base_url',
      'auth_mode',
      'pi_api',
    ]) {
      expect(overview.model).not.toHaveProperty(field);
    }
    expect(db.getSystemSecret).not.toHaveBeenCalled();
  });

  it('shows connection settings to admins without fetching or returning credential values', async () => {
    const overview = await getSystemConfigOverview();
    expect(overview).toMatchObject({
      model: { pi_api: 'openai-responses', has_secret: true },
      thinking_level: 'high',
    });
    for (const field of [
      'api_key',
      'api_key_preview',
      'api_key_fingerprint',
      'api_key_secret_key',
      'extra_json',
    ]) {
      expect(overview.model).not.toHaveProperty(field);
    }
    expect(db.getSystemSecret).not.toHaveBeenCalled();
  });

  it('represents an unconfigured deployment with an empty slot', async () => {
    db.getPlatformModelSettings.mockResolvedValue({
      model: null,
      thinkingLevel: 'medium',
      hasSecret: false,
    });
    expect(await getSystemConfigOverview()).toEqual({
      model: null,
      thinking_level: 'medium',
    });
    expect(await getUserModelSettingsOverview()).toEqual({ model: null });
  });
});

describe('single-slot updates', () => {
  it('saves the model and thinking level together through the sole writer', async () => {
    await saveOfficialModelSettings({
      ...update,
      model_name: ' gpt-4.1 ',
      base_url: ' https://provider.example/v1 ',
      actor: 'manager',
    });
    expect(db.savePlatformModelConfig).toHaveBeenCalledWith({
      piApi: 'openai-responses',
      baseUrl: 'https://provider.example/v1',
      modelName: 'gpt-4.1',
      secretValue: undefined,
      authMode: undefined,
      contextWindowTokens: null,
      thinkingLevel: 'low',
      inputTokenPricePerMillionCoins: 2,
      outputTokenPricePerMillionCoins: 8,
      actor: 'manager',
    });
  });

  it.each([
    'invalid',
    'file:///tmp/model',
    'https://name:pass@provider.example',
    'https://provider.example?key=synthetic',
    'https://provider.example#fragment',
  ])(
    'rejects invalid or credential-bearing provider URLs',
    async (base_url) => {
      await expect(
        saveOfficialModelSettings({ ...update, base_url }),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(db.savePlatformModelConfig).not.toHaveBeenCalled();
    },
  );
});

describe('runtime defaults', () => {
  it('uses fixed service limits without exposing runtime configuration', async () => {
    expect(await getAgentConcurrencyLimit()).toBe(10);
    expect(await getLocalAgentRuntimePolicy()).toEqual({
      maxProcesses: 4,
      idleTtlMs: 600_000,
    });
    expect(await getPiSessionHealthPolicy()).toEqual({
      enabled: false,
      inactiveCleanupDays: 30,
      orphanGraceDays: 30,
    });
    expect(await getUserSkillLimitPolicy()).toBe(30);
    expect(await getSkillBundleLimitsPolicy()).toEqual({
      max_files: 50,
      max_file_chars: 100_000,
      max_total_chars: 500_000,
      max_zip_bytes: 8 * 1024 * 1024,
    });
    expect(db.getPlatformModelSettings).not.toHaveBeenCalled();
  });
});
