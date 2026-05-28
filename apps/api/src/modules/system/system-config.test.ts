import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetOfficialModelConfig,
  mockGetSystemSecret,
  mockGetUserModelConfig,
  mockGetUserModelSelection,
  mockUpdateOfficialModelConfig,
  mockUpsertSystemSecret,
} = vi.hoisted(() => ({
  mockGetOfficialModelConfig: vi.fn(),
  mockGetSystemSecret: vi.fn(),
  mockGetUserModelConfig: vi.fn(),
  mockGetUserModelSelection: vi.fn(),
  mockUpdateOfficialModelConfig: vi.fn(),
  mockUpsertSystemSecret: vi.fn(),
}));

vi.mock('../../infrastructure/db.js', () => ({
  createConfigAuditLog: vi.fn(),
  getOfficialModelConfig: mockGetOfficialModelConfig,
  getSystemSecret: mockGetSystemSecret,
  getUserModelConfig: mockGetUserModelConfig,
  getUserModelSelection: mockGetUserModelSelection,
  listConfigAuditLogs: vi.fn(async () => []),
  listOfficialModelConfigs: vi.fn(async () => []),
  updateOfficialModelConfig: mockUpdateOfficialModelConfig,
  upsertSystemSecret: mockUpsertSystemSecret,
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
    input_token_price_per_million_points: 1000,
    output_token_price_per_million_points: 5000,
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
  });

  it('rejects when the user has no explicit selection', async () => {
    mockGetUserModelSelection.mockResolvedValue(undefined);

    await expect(resolveUserLlmRuntime('user-1')).rejects.toThrow('未选择模型');
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
      inputTokenPricePerMillionPoints: 1000,
      outputTokenPricePerMillionPoints: 5000,
    });
  });

  it('does not fallback when the selected official model lacks a secret', async () => {
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

    await expect(resolveUserLlmRuntime('user-1')).rejects.toThrow(
      '官方模型未配置密钥',
    );
  });

  it('resolves selected custom model with no billing', async () => {
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
      billingMode: 'none',
      providerKey: 'custom:user-1',
      piApi: 'anthropic-messages',
      model: 'claude-sonnet-4-20250514',
      contextWindowTokens: 1000000,
      maxOutputTokens: 32768,
      inputTokenPricePerMillionPoints: 0,
      outputTokenPricePerMillionPoints: 0,
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
