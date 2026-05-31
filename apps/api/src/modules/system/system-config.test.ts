import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetOfficialModelConfig,
  mockGetModelBillingConfig,
  mockGetSystemSecret,
  mockGetUserModelConfig,
  mockGetUserModelSelection,
  mockListOfficialModelConfigs,
  mockUpdateOfficialModelConfig,
  mockUpdateModelBillingConfig,
  mockUpsertSystemSecret,
} = vi.hoisted(() => ({
  mockGetOfficialModelConfig: vi.fn(),
  mockGetModelBillingConfig: vi.fn(),
  mockGetSystemSecret: vi.fn(),
  mockGetUserModelConfig: vi.fn(),
  mockGetUserModelSelection: vi.fn(),
  mockListOfficialModelConfigs: vi.fn(),
  mockUpdateOfficialModelConfig: vi.fn(),
  mockUpdateModelBillingConfig: vi.fn(),
  mockUpsertSystemSecret: vi.fn(),
}));

vi.mock('../../infrastructure/db.js', () => ({
  createConfigAuditLog: vi.fn(),
  createOfficialModelConfig: vi.fn(),
  deleteOfficialModelConfig: vi.fn(),
  getModelBillingConfig: mockGetModelBillingConfig,
  getOfficialModelConfig: mockGetOfficialModelConfig,
  getSystemSecret: mockGetSystemSecret,
  getUserModelConfig: mockGetUserModelConfig,
  getUserModelSelection: mockGetUserModelSelection,
  listConfigAuditLogs: vi.fn(async () => []),
  listOfficialModelConfigs: mockListOfficialModelConfigs,
  updateOfficialModelConfig: mockUpdateOfficialModelConfig,
  updateModelBillingConfig: mockUpdateModelBillingConfig,
  upsertSystemSecret: mockUpsertSystemSecret,
  upsertUserModelConfig: vi.fn(),
  upsertUserModelSelection: vi.fn(),
}));

import {
  resolveUserLlmRuntime,
  setOfficialModelSecret,
} from './system-config.js';
import type {
  OfficialModelConfig,
  SystemSecretRow,
  UserModelConfig,
} from '../../shared/types.js';

function secret(key = 'secret-key'): SystemSecretRow {
  return {
    key,
    secret_value: 'db-secret',
    updated_by: null,
    updated_at: '2026-05-04T00:00:00.000Z',
  };
}

function official(
  overrides: Partial<OfficialModelConfig> = {},
): OfficialModelConfig {
  return {
    id: 'official-1',
    model_key: 'openai-main',
    pi_api: 'openai-completions',
    display_name: 'OpenAI Main',
    enabled: true,
    priority: 0,
    base_url: 'https://openai.example/v1',
    model_name: 'gpt-4.1',
    api_key_secret_key: 'secret-key',
    input_token_price_per_million_coins: 1000,
    output_token_price_per_million_coins: 5000,
    extra_json: {},
    created_at: '2026-05-04T00:00:00.000Z',
    updated_at: '2026-05-04T00:00:00.000Z',
    ...overrides,
  };
}

function custom(overrides: Partial<UserModelConfig> = {}): UserModelConfig {
  return {
    user_id: 'user-1',
    pi_api: 'anthropic-messages',
    base_url: null,
    model_name: 'claude-sonnet-4-20250514',
    api_key_secret_key: 'secret-key',
    extra_json: { auth_mode: 'anthropic_api_key' },
    created_at: '2026-05-04T00:00:00.000Z',
    updated_at: '2026-05-04T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveUserLlmRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSystemSecret.mockResolvedValue(secret());
    mockListOfficialModelConfigs.mockResolvedValue([]);
    mockGetModelBillingConfig.mockResolvedValue({
      id: 'default',
      custom_model_platform_price_per_million_coins: 2,
      updated_at: '2026-05-04T00:00:00.000Z',
    });
  });

  it('rejects when the user has no explicit selection', async () => {
    mockGetUserModelSelection.mockResolvedValue(undefined);

    await expect(resolveUserLlmRuntime('user-1')).rejects.toThrow('未选择模型');
  });

  it('falls back to the lowest priced usable official model when the user has no selection', async () => {
    mockGetUserModelSelection.mockResolvedValue(undefined);
    mockListOfficialModelConfigs.mockResolvedValue([
      official({
        id: 'expensive',
        model_key: 'expensive',
        display_name: 'Expensive',
        input_token_price_per_million_coins: 1000,
        output_token_price_per_million_coins: 5000,
      }),
      official({
        id: 'missing-secret',
        model_key: 'missing-secret',
        display_name: 'Missing Secret',
        api_key_secret_key: null,
        input_token_price_per_million_coins: 1,
        output_token_price_per_million_coins: 1,
      }),
      official({
        id: 'cheapest',
        model_key: 'cheapest',
        display_name: 'Cheapest',
        model_name: 'gpt-4o-mini',
        input_token_price_per_million_coins: 2,
        output_token_price_per_million_coins: 3,
      }),
    ]);

    await expect(resolveUserLlmRuntime('user-1')).resolves.toMatchObject({
      source: 'official',
      modelConfigId: 'cheapest',
      providerKey: 'cheapest',
      model: 'gpt-4o-mini',
      inputTokenPricePerMillionCoins: 2,
      outputTokenPricePerMillionCoins: 3,
    });
  });

  it('resolves a selected official model with metered billing', async () => {
    mockGetUserModelSelection.mockResolvedValue({
      user_id: 'user-1',
      source: 'official',
      official_model_id: 'official-1',
      created_at: '2026-05-04T00:00:00.000Z',
      updated_at: '2026-05-04T00:00:00.000Z',
    });
    mockGetOfficialModelConfig.mockResolvedValue(official());

    await expect(resolveUserLlmRuntime('user-1')).resolves.toMatchObject({
      source: 'official',
      billingMode: 'metered',
      modelConfigId: 'official-1',
      providerKey: 'openai-main',
      piApi: 'openai-completions',
      model: 'gpt-4.1',
      contextWindowTokens: 128000,
      maxOutputTokens: 10240,
      inputTokenPricePerMillionCoins: 1000,
      outputTokenPricePerMillionCoins: 5000,
    });
  });

  it('falls back when the selected official model lacks a secret', async () => {
    mockGetUserModelSelection.mockResolvedValue({
      user_id: 'user-1',
      source: 'official',
      official_model_id: 'official-1',
      created_at: '2026-05-04T00:00:00.000Z',
      updated_at: '2026-05-04T00:00:00.000Z',
    });
    mockGetOfficialModelConfig.mockResolvedValue(
      official({ api_key_secret_key: null }),
    );
    mockListOfficialModelConfigs.mockResolvedValue([
      official({
        id: 'fallback',
        model_key: 'fallback',
        display_name: 'Fallback',
        model_name: 'gpt-4o-mini',
        input_token_price_per_million_coins: 10,
        output_token_price_per_million_coins: 20,
      }),
    ]);

    await expect(resolveUserLlmRuntime('user-1')).resolves.toMatchObject({
      source: 'official',
      modelConfigId: 'fallback',
      providerKey: 'fallback',
      model: 'gpt-4o-mini',
    });
  });

  it('resolves selected custom model with platform token billing', async () => {
    mockGetUserModelSelection.mockResolvedValue({
      user_id: 'user-1',
      source: 'custom',
      official_model_id: null,
      created_at: '2026-05-04T00:00:00.000Z',
      updated_at: '2026-05-04T00:00:00.000Z',
    });
    mockGetUserModelConfig.mockResolvedValue(custom());

    await expect(resolveUserLlmRuntime('user-1')).resolves.toMatchObject({
      source: 'custom',
      billingMode: 'metered',
      providerKey: 'custom:user-1',
      piApi: 'anthropic-messages',
      model: 'claude-sonnet-4-20250514',
      contextWindowTokens: 1000000,
      maxOutputTokens: 32768,
      inputTokenPricePerMillionCoins: 2,
      outputTokenPricePerMillionCoins: 2,
    });
  });

  it('uses configured platform price for selected custom model billing', async () => {
    mockGetModelBillingConfig.mockResolvedValue({
      id: 'default',
      custom_model_platform_price_per_million_coins: 9,
      updated_at: '2026-05-04T00:00:00.000Z',
    });
    mockGetUserModelSelection.mockResolvedValue({
      user_id: 'user-1',
      source: 'custom',
      official_model_id: null,
      created_at: '2026-05-04T00:00:00.000Z',
      updated_at: '2026-05-04T00:00:00.000Z',
    });
    mockGetUserModelConfig.mockResolvedValue(custom());

    await expect(resolveUserLlmRuntime('user-1')).resolves.toMatchObject({
      inputTokenPricePerMillionCoins: 9,
      outputTokenPricePerMillionCoins: 9,
    });
  });

  it('falls back when the selected custom model is not usable', async () => {
    mockGetUserModelSelection.mockResolvedValue({
      user_id: 'user-1',
      source: 'custom',
      official_model_id: null,
      created_at: '2026-05-04T00:00:00.000Z',
      updated_at: '2026-05-04T00:00:00.000Z',
    });
    mockGetUserModelConfig.mockResolvedValue(undefined);
    mockListOfficialModelConfigs.mockResolvedValue([
      official({
        id: 'fallback',
        model_key: 'fallback',
        display_name: 'Fallback',
        model_name: 'gpt-4o-mini',
      }),
    ]);

    await expect(resolveUserLlmRuntime('user-1')).resolves.toMatchObject({
      source: 'official',
      modelConfigId: 'fallback',
      providerKey: 'fallback',
      model: 'gpt-4o-mini',
    });
  });

  it('uses configured context window without passing it as max output tokens', async () => {
    mockGetUserModelSelection.mockResolvedValue({
      user_id: 'user-1',
      source: 'official',
      official_model_id: 'official-1',
      created_at: '2026-05-04T00:00:00.000Z',
      updated_at: '2026-05-04T00:00:00.000Z',
    });
    mockGetOfficialModelConfig.mockResolvedValue(
      official({ extra_json: { context_window_tokens: 899998 } }),
    );

    await expect(resolveUserLlmRuntime('user-1')).resolves.toMatchObject({
      contextWindowTokens: 899998,
      maxOutputTokens: 32768,
    });
  });

});

describe('setOfficialModelSecret', () => {
  it('stores official model secrets as database values', async () => {
    mockGetOfficialModelConfig.mockResolvedValue(
      official({ api_key_secret_key: null }),
    );
    mockUpsertSystemSecret.mockResolvedValue(
      secret('official-model:official-1:secret'),
    );
    mockUpdateOfficialModelConfig.mockResolvedValue(
      official({ api_key_secret_key: 'official-model:official-1:secret' }),
    );

    await setOfficialModelSecret({
      modelId: 'official-1',
      secretValue: 'plain-secret',
      authMode: 'openai_api_key',
      actor: 'admin',
    });

    expect(mockUpsertSystemSecret).toHaveBeenCalledWith({
      key: 'official-model:official-1:secret',
      secretValue: 'plain-secret',
      updatedBy: 'admin',
    });
  });
});
