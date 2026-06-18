import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetOfficialModelConfig,
  mockGetModelBillingConfig,
  mockGetMembershipOverview,
  mockGetRuntimeConfig,
  mockGetSystemSecret,
  mockGetUserById,
  mockGetUserModelConfig,
  mockGetUserModelSelection,
  mockListOfficialModelConfigs,
  mockDeleteOfficialModelConfig,
  mockDeleteUserModelSelectionsByOfficialModelId,
  mockUpdateOfficialModelConfig,
  mockUpdateModelBillingConfig,
  mockUpdateRuntimeConfig,
  mockUpsertSystemSecret,
  mockUpsertUserModelConfig,
  mockUpsertUserModelSelection,
} = vi.hoisted(() => ({
  mockGetOfficialModelConfig: vi.fn(),
  mockGetModelBillingConfig: vi.fn(),
  mockGetMembershipOverview: vi.fn(),
  mockGetRuntimeConfig: vi.fn(),
  mockGetSystemSecret: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetUserModelConfig: vi.fn(),
  mockGetUserModelSelection: vi.fn(),
  mockListOfficialModelConfigs: vi.fn(),
  mockDeleteOfficialModelConfig: vi.fn(),
  mockDeleteUserModelSelectionsByOfficialModelId: vi.fn(),
  mockUpdateOfficialModelConfig: vi.fn(),
  mockUpdateModelBillingConfig: vi.fn(),
  mockUpdateRuntimeConfig: vi.fn(),
  mockUpsertSystemSecret: vi.fn(),
  mockUpsertUserModelConfig: vi.fn(),
  mockUpsertUserModelSelection: vi.fn(),
}));

vi.mock('../../../src/infrastructure/db.js', () => ({
  createConfigAuditLog: vi.fn(),
  createOfficialModelConfig: vi.fn(),
  deleteOfficialModelConfig: mockDeleteOfficialModelConfig,
  deleteUserModelSelectionsByOfficialModelId:
    mockDeleteUserModelSelectionsByOfficialModelId,
  expireUserBonusBalanceBefore: vi.fn(async () => ({
    expired: 0,
    totalCoinsExpired: 0,
  })),
  getModelBillingConfig: mockGetModelBillingConfig,
  getMembershipOverview: mockGetMembershipOverview,
  getOfficialModelConfig: mockGetOfficialModelConfig,
  getRuntimeConfig: mockGetRuntimeConfig,
  getSystemSecret: mockGetSystemSecret,
  getUserById: mockGetUserById,
  getUserModelConfig: mockGetUserModelConfig,
  getUserModelSelection: mockGetUserModelSelection,
  listConfigAuditLogs: vi.fn(async () => []),
  listOfficialModelConfigs: mockListOfficialModelConfigs,
  updateOfficialModelConfig: mockUpdateOfficialModelConfig,
  updateModelBillingConfig: mockUpdateModelBillingConfig,
  updateRuntimeConfig: mockUpdateRuntimeConfig,
  upsertSystemSecret: mockUpsertSystemSecret,
  upsertUserModelConfig: mockUpsertUserModelConfig,
  upsertUserModelSelection: mockUpsertUserModelSelection,
}));

import {
  getLocalAgentRuntimePolicy,
  getPiSessionHealthPolicy,
  getSkillBundleLimitsPolicy,
  getSystemConfigOverview,
  getUserSkillLimitPolicy,
  getUserModelSettingsOverview,
  listOfficialModelViews,
  normalizeCustomModelBaseUrl,
  removeOfficialModel,
  resolveUserLlmRuntime,
  saveUserCustomModelConfig,
  setUserModelSelection,
  updateOfficialModel,
} from '../../../src/modules/system/system-config.js';
import type {
  OfficialModelConfig,
  RuntimeConfig,
  SystemSecretRow,
  UserModelConfig,
} from '../../../src/shared/types.js';

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

function membership(active = true) {
  return {
    active,
    membership: active ? { plan_key: 'fateclaw_insight' } : null,
  };
}

function runtimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    id: 'default',
    agent_concurrency_limit: 10,
    local_agent_max_processes: 4,
    local_agent_idle_ttl_ms: 600_000,
    default_official_model_id: null,
    default_thinking_level: 'medium',
    pi_session_health_enabled: false,
    pi_session_inactive_cleanup_days: 30,
    pi_session_orphan_grace_days: 30,
    user_skill_max_count: 30,
    skill_bundle_max_files: 50,
    skill_bundle_max_file_chars: 100_000,
    skill_bundle_max_total_chars: 500_000,
    skill_bundle_max_zip_bytes: 8 * 1024 * 1024,
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
    mockGetUserById.mockResolvedValue({
      id: 'user-1',
      purchased_coins: 0,
      bonus_coins: 0,
      reserved_coins: 0,
    });
    mockGetMembershipOverview.mockResolvedValue(membership());
    mockGetRuntimeConfig.mockResolvedValue(runtimeConfig());
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
      thinkingLevel: 'medium',
      inputTokenPricePerMillionCoins: 2,
      outputTokenPricePerMillionCoins: 3,
    });
  });

  it('uses the configured default official model before the lowest priced fallback', async () => {
    mockGetUserModelSelection.mockResolvedValue(undefined);
    mockGetRuntimeConfig.mockResolvedValue(
      runtimeConfig({
        default_official_model_id: 'configured-default',
      }),
    );
    mockGetOfficialModelConfig.mockResolvedValue(
      official({
        id: 'configured-default',
        model_key: 'configured-default',
        display_name: 'Configured Default',
        model_name: 'gpt-configured',
        input_token_price_per_million_coins: 100,
        output_token_price_per_million_coins: 100,
      }),
    );
    mockListOfficialModelConfigs.mockResolvedValue([
      official({
        id: 'cheapest',
        model_key: 'cheapest',
        display_name: 'Cheapest',
        model_name: 'gpt-cheapest',
        input_token_price_per_million_coins: 1,
        output_token_price_per_million_coins: 1,
      }),
    ]);

    await expect(resolveUserLlmRuntime('user-1')).resolves.toMatchObject({
      source: 'official',
      modelConfigId: 'configured-default',
      providerKey: 'configured-default',
      model: 'gpt-configured',
    });
  });

  it('uses the configured default thinking level when the user has no selection', async () => {
    mockGetUserModelSelection.mockResolvedValue(undefined);
    mockGetRuntimeConfig.mockResolvedValue(
      runtimeConfig({
        default_thinking_level: 'high',
      }),
    );
    mockListOfficialModelConfigs.mockResolvedValue([
      official({
        id: 'fallback',
        model_key: 'fallback',
        display_name: 'Fallback',
        model_name: 'gpt-fallback',
      }),
    ]);

    await expect(resolveUserLlmRuntime('user-1')).resolves.toMatchObject({
      source: 'official',
      modelConfigId: 'fallback',
      thinkingLevel: 'high',
    });
  });

  it('falls back to the lowest priced model when the configured default is unusable', async () => {
    mockGetUserModelSelection.mockResolvedValue(undefined);
    mockGetRuntimeConfig.mockResolvedValue(
      runtimeConfig({
        default_official_model_id: 'configured-default',
      }),
    );
    mockGetOfficialModelConfig.mockResolvedValue(
      official({
        id: 'configured-default',
        enabled: false,
        model_key: 'configured-default',
        display_name: 'Configured Default',
        model_name: 'gpt-configured',
      }),
    );
    mockListOfficialModelConfigs.mockResolvedValue([
      official({
        id: 'fallback',
        model_key: 'fallback',
        display_name: 'Fallback',
        model_name: 'gpt-fallback',
        input_token_price_per_million_coins: 1,
        output_token_price_per_million_coins: 1,
      }),
    ]);

    await expect(resolveUserLlmRuntime('user-1')).resolves.toMatchObject({
      source: 'official',
      modelConfigId: 'fallback',
      providerKey: 'fallback',
      model: 'gpt-fallback',
    });
  });

  it('resolves a selected official model with metered billing', async () => {
    mockGetUserModelSelection.mockResolvedValue({
      user_id: 'user-1',
      source: 'official',
      official_model_id: 'official-1',
      thinking_level: 'high',
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
      thinkingLevel: 'high',
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

  it('resolves selected custom model as a member-only metered model with platform billing', async () => {
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
      thinkingLevel: 'medium',
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

  it('falls back to official models when a selected custom model lacks membership entitlement', async () => {
    mockGetMembershipOverview.mockResolvedValue(membership(false));
    mockGetUserModelSelection.mockResolvedValue({
      user_id: 'user-1',
      source: 'custom',
      official_model_id: null,
      created_at: '2026-05-04T00:00:00.000Z',
      updated_at: '2026-05-04T00:00:00.000Z',
    });
    mockGetUserModelConfig.mockResolvedValue(custom());
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
    });
  });

  it('does not expose the current user custom API key', async () => {
    mockGetUserModelConfig.mockResolvedValue(custom());
    mockGetUserModelSelection.mockResolvedValue(null);

    await expect(getUserModelSettingsOverview('user-1')).resolves.toMatchObject(
      {
        custom: {
          user_id: 'user-1',
          has_secret: true,
          api_key: null,
          api_key_preview: '...cret',
        },
        official_models: [],
        custom_model_membership_required: true,
        custom_model_membership_entitled: true,
      },
    );
  });

  it('rejects historical custom model private base URLs at runtime', async () => {
    mockGetUserModelSelection.mockResolvedValue({
      user_id: 'user-1',
      source: 'custom',
      official_model_id: null,
      created_at: '2026-05-04T00:00:00.000Z',
      updated_at: '2026-05-04T00:00:00.000Z',
    });
    mockGetUserModelConfig.mockResolvedValue(
      custom({ base_url: 'http://169.254.169.254/latest' }),
    );

    await expect(resolveUserLlmRuntime('user-1')).rejects.toThrow(
      'Base URL 不能指向本机、内网、链路本地或云 metadata 地址',
    );
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

describe('getLocalAgentRuntimePolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes local agent process and idle ttl limits', async () => {
    mockGetRuntimeConfig.mockResolvedValue(
      runtimeConfig({
        local_agent_max_processes: 999,
        local_agent_idle_ttl_ms: 1,
      }),
    );
    mockGetUserById.mockResolvedValue({
      id: 'user-1',
      purchased_coins: 0,
      bonus_coins: 0,
      reserved_coins: 0,
    });

    await expect(getLocalAgentRuntimePolicy()).resolves.toEqual({
      maxProcesses: 100,
      idleTtlMs: 30_000,
    });
  });
});

describe('getPiSessionHealthPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes Pi session health policy days', async () => {
    mockGetRuntimeConfig.mockResolvedValue(
      runtimeConfig({
        pi_session_health_enabled: true,
        pi_session_inactive_cleanup_days: 0,
        pi_session_orphan_grace_days: 5000,
      }),
    );
    mockGetUserById.mockResolvedValue({
      id: 'user-1',
      purchased_coins: 0,
      bonus_coins: 0,
      reserved_coins: 0,
    });

    await expect(getPiSessionHealthPolicy()).resolves.toEqual({
      enabled: true,
      inactiveCleanupDays: 1,
      orphanGraceDays: 3650,
    });
  });
});

describe('getSkillBundleLimitsPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes Skill Bundle file limits from runtime config', async () => {
    mockGetRuntimeConfig.mockResolvedValue(
      runtimeConfig({
        skill_bundle_max_files: 999,
        skill_bundle_max_file_chars: 3_000_000,
        skill_bundle_max_total_chars: 2,
        skill_bundle_max_zip_bytes: 1,
      }),
    );

    await expect(getSkillBundleLimitsPolicy()).resolves.toEqual({
      max_files: 500,
      max_file_chars: 2_000_000,
      max_total_chars: 2_000_000,
      max_zip_bytes: 1024,
    });
  });
});

describe('getUserSkillLimitPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes user custom skill count limit from runtime config', async () => {
    mockGetRuntimeConfig.mockResolvedValue(
      runtimeConfig({
        user_skill_max_count: 999,
      }),
    );

    await expect(getUserSkillLimitPolicy()).resolves.toBe(500);
  });
});

describe('normalizeCustomModelBaseUrl', () => {
  it('allows public http and https URLs with paths', () => {
    expect(normalizeCustomModelBaseUrl('https://models.example.com/v1')).toBe(
      'https://models.example.com/v1',
    );
    expect(normalizeCustomModelBaseUrl('http://models.example.com/v1')).toBe(
      'http://models.example.com/v1',
    );
  });

  it('rejects localhost, private CIDR, link-local, metadata and internal hosts', () => {
    const blocked = [
      'http://localhost:11434/v1',
      'http://127.0.0.1/v1',
      'http://10.0.0.2/v1',
      'http://172.16.0.1/v1',
      'http://192.168.1.8/v1',
      'http://169.254.169.254/latest',
      'http://[::1]/v1',
      'https://metadata.google.internal/computeMetadata/v1',
      'https://ollama/v1',
      'https://gateway.local/v1',
    ];

    for (const url of blocked) {
      expect(() => normalizeCustomModelBaseUrl(url), url).toThrow(/Base URL/);
    }
  });

  it('rejects unsupported schemes and credential-bearing URLs', () => {
    expect(() => normalizeCustomModelBaseUrl('file:///etc/passwd')).toThrow(
      'Base URL 仅支持 http 或 https',
    );
    expect(() =>
      normalizeCustomModelBaseUrl('https://user:pass@models.example.com/v1'),
    ).toThrow('Base URL 不允许包含用户名或密码');
  });
});

describe('saveUserCustomModelConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserModelConfig.mockResolvedValue(undefined);
    mockGetMembershipOverview.mockResolvedValue(membership());
    mockUpsertSystemSecret.mockResolvedValue(
      secret('user-model:user-1:secret'),
    );
    mockUpsertUserModelConfig.mockResolvedValue(custom());
  });

  it('stores only validated public custom model base URLs', async () => {
    await saveUserCustomModelConfig({
      userId: 'user-1',
      piApi: 'openai-completions',
      baseUrl: 'https://models.example.com/v1',
      modelName: 'gpt-4o',
      secretValue: 'plain-secret',
    });

    expect(mockUpsertUserModelConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://models.example.com/v1',
      }),
    );
  });

  it('rejects private custom model base URLs before saving', async () => {
    await expect(
      saveUserCustomModelConfig({
        userId: 'user-1',
        piApi: 'openai-completions',
        baseUrl: 'http://192.168.1.2/v1',
        modelName: 'gpt-4o',
        secretValue: 'plain-secret',
      }),
    ).rejects.toThrow(
      'Base URL 不能指向本机、内网、链路本地或云 metadata 地址',
    );

    expect(mockUpsertUserModelConfig).not.toHaveBeenCalled();
    expect(mockUpsertSystemSecret).not.toHaveBeenCalled();
  });

  it('keeps the existing secret when an empty API key is submitted', async () => {
    mockGetUserModelConfig.mockResolvedValue(
      custom({ api_key_secret_key: 'user-model:user-1:secret' }),
    );

    await saveUserCustomModelConfig({
      userId: 'user-1',
      piApi: 'openai-completions',
      baseUrl: 'https://models.example.com/v1',
      modelName: 'gpt-4o',
      secretValue: '',
    });

    expect(mockUpsertSystemSecret).not.toHaveBeenCalled();
    expect(mockUpsertUserModelConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeySecretKey: 'user-model:user-1:secret',
      }),
    );
  });

  it('rejects custom model saves without membership entitlement', async () => {
    mockGetMembershipOverview.mockResolvedValue(membership(false));

    await expect(
      saveUserCustomModelConfig({
        userId: 'user-1',
        piApi: 'openai-completions',
        baseUrl: 'https://models.example.com/v1',
        modelName: 'gpt-4o',
        secretValue: 'plain-secret',
      }),
    ).rejects.toThrow('自配模型为会员专属，请开通会员后使用');

    expect(mockUpsertUserModelConfig).not.toHaveBeenCalled();
    expect(mockUpsertSystemSecret).not.toHaveBeenCalled();
  });
});

describe('listOfficialModelViews', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSystemSecret.mockResolvedValue(secret());
    mockListOfficialModelConfigs.mockResolvedValue([official()]);
    mockGetModelBillingConfig.mockResolvedValue({
      id: 'default',
      custom_model_platform_price_per_million_coins: 2,
      updated_at: '2026-05-04T00:00:00.000Z',
    });
    mockGetRuntimeConfig.mockResolvedValue(
      runtimeConfig({
        user_skill_max_count: 42,
        skill_bundle_max_files: 12,
        skill_bundle_max_file_chars: 20_000,
        skill_bundle_max_total_chars: 80_000,
        skill_bundle_max_zip_bytes: 2 * 1024 * 1024,
      }),
    );
  });

  it('does not expose official model API keys by default', async () => {
    await expect(listOfficialModelViews()).resolves.toMatchObject([
      {
        id: 'official-1',
        has_secret: true,
        api_key: null,
      },
    ]);
  });

  it('includes official model API keys for the admin overview', async () => {
    await expect(getSystemConfigOverview()).resolves.toMatchObject({
      providers: [
        {
          id: 'official-1',
          has_secret: true,
          api_key: 'db-secret',
        },
      ],
    });
  });
});

describe('updateOfficialModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates config and API key in one save', async () => {
    mockGetOfficialModelConfig.mockResolvedValue(
      official({ api_key_secret_key: null }),
    );
    mockUpsertSystemSecret.mockResolvedValue(
      secret('official-model:official-1:secret'),
    );
    mockUpdateOfficialModelConfig.mockResolvedValue(
      official({ api_key_secret_key: 'official-model:official-1:secret' }),
    );

    await updateOfficialModel({
      id: 'official-1',
      modelKey: 'openai-main',
      piApi: 'openai-completions',
      displayName: 'OpenAI Main',
      enabled: true,
      priority: 0,
      baseUrl: 'https://openai.example/v1',
      modelName: 'gpt-4.1',
      secretValue: 'plain-secret',
      inputTokenPricePerMillionCoins: 1000,
      outputTokenPricePerMillionCoins: 5000,
      actor: 'admin',
    });

    expect(mockUpsertSystemSecret).toHaveBeenCalledWith({
      key: 'official-model:official-1:secret',
      secretValue: 'plain-secret',
      updatedBy: 'admin',
    });
    expect(mockUpdateOfficialModelConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeySecretKey: 'official-model:official-1:secret',
      }),
    );
  });
});

describe('setUserModelSelection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserModelSelection.mockResolvedValue(undefined);
    mockGetMembershipOverview.mockResolvedValue(membership());
    mockGetRuntimeConfig.mockResolvedValue(
      runtimeConfig({
        default_thinking_level: 'high',
      }),
    );
    mockUpsertUserModelSelection.mockResolvedValue({
      user_id: 'user-1',
      source: 'custom',
      official_model_id: null,
      thinking_level: 'high',
      created_at: '2026-05-04T00:00:00.000Z',
      updated_at: '2026-05-04T00:00:00.000Z',
    });
  });

  it('uses the configured default thinking level for first-time selections', async () => {
    await setUserModelSelection({
      userId: 'user-1',
      source: 'custom',
    });

    expect(mockUpsertUserModelSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        source: 'custom',
        officialModelId: null,
        thinkingLevel: 'high',
      }),
    );
  });

  it('rejects custom selections without membership entitlement', async () => {
    mockGetMembershipOverview.mockResolvedValue(membership(false));

    await expect(
      setUserModelSelection({
        userId: 'user-1',
        source: 'custom',
      }),
    ).rejects.toThrow('自配模型为会员专属，请开通会员后使用');

    expect(mockUpsertUserModelSelection).not.toHaveBeenCalled();
  });
});

describe('removeOfficialModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes user selections before deleting the official model', async () => {
    mockGetOfficialModelConfig.mockResolvedValue(official());
    mockDeleteUserModelSelectionsByOfficialModelId.mockResolvedValue(2);

    await removeOfficialModel('official-1', 'admin');

    expect(mockDeleteUserModelSelectionsByOfficialModelId).toHaveBeenCalledWith(
      'official-1',
    );
    expect(mockDeleteOfficialModelConfig).toHaveBeenCalledWith('official-1');
    expect(
      mockDeleteUserModelSelectionsByOfficialModelId.mock
        .invocationCallOrder[0],
    ).toBeLessThan(mockDeleteOfficialModelConfig.mock.invocationCallOrder[0]);
  });
});
