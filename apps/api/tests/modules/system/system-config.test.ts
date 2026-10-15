import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  getPlatformModelSettings: vi.fn(),
  getPlatformModelRuntimeSettings: vi.fn(),
  getSystemSecret: vi.fn(),
  savePlatformModelConfig: vi.fn(),
  getUserModelSelection: vi.fn(),
  getUserModelConfig: vi.fn(),
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
import type { PlatformModelSettings } from '../../../src/infrastructure/repositories/config-repository.js';

const model = {
  id: 'node-a',
  model_key: 'provider-a',
  pi_api: 'openai-responses' as const,
  display_name: 'Provider A',
  enabled: true,
  priority: 0,
  base_url: null,
  model_name: 'gpt-4.1',
  api_key_secret_key: 'synthetic-key-ref',
  input_token_price_per_million_coins: 99,
  output_token_price_per_million_coins: 99,
  extra_json: { context_window_tokens: 256_000 },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};
const settings: PlatformModelSettings = {
  pool: {
    primary_node_id: model.id,
    public_model_id: 'official-pool',
    model_key: 'official',
    display_name: 'Official pool',
    thinking_level: 'high',
    input_token_price_per_million_coins: 2,
    output_token_price_per_million_coins: 8,
  },
  nodes: [
    {
      model,
      weight: 2,
      revision: 1,
      hasSecret: true,
      failureCount: 0,
      cooldownUntil: null,
    },
  ],
};
const update = {
  display_name: 'Official pool',
  thinking_level: 'low' as const,
  input_token_price_per_million_coins: 2,
  output_token_price_per_million_coins: 8,
  nodes: [
    {
      id: model.id,
      display_name: model.display_name,
      pi_api: 'openai-responses' as const,
      base_url: null,
      model_name: model.model_name,
      context_window_tokens: null,
      enabled: true,
      weight: 2,
    },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  db.getPlatformModelSettings.mockResolvedValue(structuredClone(settings));
  db.getPlatformModelRuntimeSettings.mockImplementation(async () => {
    const result = await db.getPlatformModelSettings();
    return {
      ...result,
      nodes: result.nodes.map((node: object) => ({
        ...node,
        secretValue: 'synthetic-runtime-key',
      })),
    };
  });
  db.savePlatformModelConfig.mockResolvedValue(settings);
});

describe('official model pool', () => {
  it('captures different providers together with a common capacity, prices and thinking level', async () => {
    db.getPlatformModelSettings.mockResolvedValue({
      ...settings,
      nodes: [
        ...settings.nodes,
        {
          ...settings.nodes[0],
          weight: 1,
          revision: 3,
          model: {
            ...model,
            id: 'node-b',
            model_key: 'provider-b',
            pi_api: 'anthropic-messages',
            model_name: 'synthetic-claude',
            extra_json: { context_window_tokens: 32_000 },
          },
        },
      ],
    });
    const runtime = await resolveUserLlmRuntime('user');
    expect(runtime).toMatchObject({
      source: 'official',
      billingMode: 'metered',
      modelConfigId: 'official-pool',
      thinkingLevel: 'high',
      contextWindowTokens: 32_000,
      inputTokenPricePerMillionCoins: 2,
      outputTokenPricePerMillionCoins: 8,
      poolNodes: [
        {
          modelConfigId: 'node-a',
          weight: 2,
          revision: 1,
          piApi: 'openai-responses',
          apiKey: 'synthetic-runtime-key',
        },
        {
          modelConfigId: 'node-b',
          weight: 1,
          revision: 3,
          piApi: 'anthropic-messages',
          apiKey: 'synthetic-runtime-key',
        },
      ],
    });
    expect(runtime.maxOutputTokens).toBeLessThan(runtime.contextWindowTokens);
    expect(db.getSystemSecret).not.toHaveBeenCalled();
    expect(db.getUserModelSelection).not.toHaveBeenCalled();
    expect(db.getUserModelConfig).not.toHaveBeenCalled();
  });

  it('publishes a single stable pool alias and hides node connections and credentials', async () => {
    expect(await listPublicOfficialModels()).toEqual([
      { model_key: 'official', display_name: 'Official pool' },
    ]);
    expect(await resolveOfficialRuntimeByModelKey('official')).not.toBeNull();
    expect(await resolveOfficialRuntimeByModelKey()).not.toBeNull();
    expect(await resolveOfficialRuntimeByModelKey('provider-a')).toBeNull();
    const overview = await getUserModelSettingsOverview('user');
    expect(overview.model).toMatchObject({
      model_name: 'official',
      input_token_price_per_million_coins: 2,
    });
    for (const field of [
      'nodes',
      'pi_api',
      'base_url',
      'api_key',
      'api_key_secret_key',
      'thinking_level',
    ]) {
      expect(overview.model).not.toHaveProperty(field);
    }
    expect(db.getSystemSecret).not.toHaveBeenCalled();
  });

  it('excludes disabled and unconfigured nodes from the runtime and capacity limit', async () => {
    db.getPlatformModelSettings.mockResolvedValue({
      ...settings,
      nodes: [
        ...settings.nodes,
        {
          ...settings.nodes[0],
          model: {
            ...model,
            id: 'disabled',
            enabled: false,
            extra_json: { context_window_tokens: 8192 },
          },
        },
        {
          ...settings.nodes[0],
          hasSecret: false,
          model: {
            ...model,
            id: 'unconfigured',
            extra_json: { context_window_tokens: 8192 },
          },
        },
      ],
    });
    expect(await resolveUserLlmRuntime('user')).toMatchObject({
      contextWindowTokens: 256_000,
      poolNodes: [{ modelConfigId: 'node-a' }],
    });
  });

  it('fails explicitly when no configured node can run', async () => {
    db.getPlatformModelSettings.mockResolvedValue({ ...settings, nodes: [] });
    await expect(resolveUserLlmRuntime('user')).rejects.toThrow(
      '官方模型暂不可用',
    );
    expect(await listPublicOfficialModels()).toEqual([]);
    expect(await getUserModelSettingsOverview()).toEqual({ model: null });
    expect(await getSystemConfigOverview()).toMatchObject({
      model: { has_secret: false },
      nodes: [],
    });
  });

  it('shows node health to administrators without retrieving credential values', async () => {
    db.getPlatformModelSettings.mockResolvedValue({
      ...settings,
      nodes: [
        {
          ...settings.nodes[0],
          failureCount: 2,
          cooldownUntil: '2026-10-15T12:00:00Z',
        },
      ],
    });
    expect(await getSystemConfigOverview()).toMatchObject({
      thinking_level: 'high',
      nodes: [
        {
          id: model.id,
          is_primary: true,
          failure_count: 2,
          cooldown_until: '2026-10-15T12:00:00Z',
          has_secret: true,
        },
      ],
    });
    expect(db.getPlatformModelRuntimeSettings).not.toHaveBeenCalled();
  });

  it('preserves per-node Anthropic OAuth authentication', async () => {
    db.getPlatformModelSettings.mockResolvedValue({
      ...settings,
      nodes: [
        {
          ...settings.nodes[0],
          model: {
            ...model,
            pi_api: 'anthropic-messages',
            extra_json: { auth_mode: 'claude_code_oauth_token' },
          },
        },
      ],
    });
    expect(await resolveUserLlmRuntime('user')).toMatchObject({
      poolNodes: [{ authMode: 'claude_code_oauth_token' }],
    });
  });
});

describe('pool updates', () => {
  it('normalizes node fields and sends all settings to the same atomic writer', async () => {
    await saveOfficialModelSettings({
      ...update,
      nodes: [
        {
          ...update.nodes[0],
          model_name: ' gpt-4.1 ',
          base_url: ' https://provider.example/v1 ',
        },
      ],
      actor: 'manager',
    });
    expect(db.savePlatformModelConfig).toHaveBeenCalledWith({
      displayName: 'Official pool',
      thinkingLevel: 'low',
      inputTokenPricePerMillionCoins: 2,
      outputTokenPricePerMillionCoins: 8,
      actor: 'manager',
      nodes: [
        {
          id: model.id,
          displayName: model.display_name,
          piApi: 'openai-responses',
          baseUrl: 'https://provider.example/v1',
          modelName: 'gpt-4.1',
          secretValue: undefined,
          authMode: undefined,
          contextWindowTokens: null,
          enabled: true,
          weight: 2,
        },
      ],
    });
  });
  it.each([
    'invalid',
    'file:///tmp/model',
    'https://name:pass@provider.example',
    'https://provider.example?key=synthetic',
    'https://provider.example#fragment',
  ])('rejects invalid or credential-bearing node URLs', async (base_url) => {
    await expect(
      saveOfficialModelSettings({
        ...update,
        nodes: [{ ...update.nodes[0], base_url }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(db.savePlatformModelConfig).not.toHaveBeenCalled();
  });
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
