import { describe, expect, it, vi } from 'vitest';

import type { ModelSettingsOverview } from '@/features/model-settings/api';
import type {
  SubscribedSkill,
  UserCustomSkill,
  UserSkillsResponse,
} from '@/features/skills/api';

vi.mock('@/features/model-settings/api', () => ({
  modelSettingsApi: {
    overview: vi.fn(),
  },
}));

vi.mock('@/features/skills/api', () => ({
  skillsApi: {
    userList: vi.fn(),
  },
}));

import {
  getEnabledSkillSummaries,
  hasUsableModelForGuide,
  resolveGuideStep,
} from '../../../components/ai-chat/use-onboarding-guide-status';

const baseModelOverview: ModelSettingsOverview = {
  custom: null,
  selection: null,
  official_models: [],
  default_official_model_id: null,
  default_thinking_level: 'medium',
  custom_model_membership_required: true,
  custom_model_membership_entitled: true,
  custom_model_platform_price_per_million_coins: 0,
};

function officialModel(
  patch: Partial<ModelSettingsOverview['official_models'][number]> = {},
): ModelSettingsOverview['official_models'][number] {
  return {
    id: 'official-1',
    model_key: 'official-model',
    pi_api: 'openai-responses',
    display_name: '官方模型',
    description: '测试官方模型',
    enabled: true,
    priority: 0,
    base_url: null,
    model_name: 'gpt-test',
    context_window_tokens: null,
    input_token_price_per_million_coins: 1,
    output_token_price_per_million_coins: 1,
    has_secret: true,
    auth_mode: 'openai_api_key',
    ...patch,
  };
}

function customSkill(patch: Partial<UserCustomSkill> = {}): UserCustomSkill {
  return {
    id: 'skill-1',
    user_id: 'user-1',
    skill_name: '八字基础',
    dir_name: 'bazi-basic',
    description: '测试 Skill',
    version: '1.0.0',
    bundle_uri: 'file:///skill',
    checksum: null,
    install_status: 'installed',
    acl: {},
    billing_policy: {},
    audit_metadata: {},
    files: [],
    content_length: 0,
    visibility: 'private',
    share_token: null,
    enabled: true,
    stat_subscriber_count: 0,
    stat_view_count: 0,
    created_at: '2026-06-06T00:00:00.000Z',
    updated_at: '2026-06-06T00:00:00.000Z',
    ...patch,
  };
}

function subscribedSkill(
  patch: Partial<SubscribedSkill> = {},
): SubscribedSkill {
  return {
    ...customSkill({
      id: 'skill-2',
      skill_name: '紫微基础',
      enabled: false,
    }),
    subscription_id: 'sub-1',
    subscription_enabled: true,
    author_label: '作者',
    has_direct_source: false,
    source_bundles: [],
    ...patch,
  };
}

describe('onboarding guide status helpers', () => {
  it('treats available official fallback models as model-ready', () => {
    expect(
      hasUsableModelForGuide({
        ...baseModelOverview,
        official_models: [officialModel()],
      }),
    ).toBe(true);
  });

  it('treats a usable custom selection as model-ready', () => {
    expect(
      hasUsableModelForGuide({
        ...baseModelOverview,
        custom: {
          user_id: 'user-1',
          pi_api: 'openai-responses',
          base_url: null,
          model_name: 'custom-model',
          context_window_tokens: null,
          has_secret: true,
          api_key_preview: null,
          api_key_fingerprint: null,
          api_key: null,
          auth_mode: 'openai_api_key',
          created_at: '2026-06-06T00:00:00.000Z',
          updated_at: '2026-06-06T00:00:00.000Z',
        },
        selection: {
          user_id: 'user-1',
          source: 'custom',
          official_model_id: null,
          thinking_level: 'medium',
          created_at: '2026-06-06T00:00:00.000Z',
          updated_at: '2026-06-06T00:00:00.000Z',
        },
      }),
    ).toBe(true);
  });

  it('does not treat custom selections as ready without membership entitlement', () => {
    expect(
      hasUsableModelForGuide({
        ...baseModelOverview,
        custom_model_membership_entitled: false,
        custom: {
          user_id: 'user-1',
          pi_api: 'openai-responses',
          base_url: null,
          model_name: 'custom-model',
          context_window_tokens: null,
          has_secret: true,
          api_key_preview: null,
          api_key_fingerprint: null,
          api_key: null,
          auth_mode: 'openai_api_key',
          created_at: '2026-06-06T00:00:00.000Z',
          updated_at: '2026-06-06T00:00:00.000Z',
        },
        selection: {
          user_id: 'user-1',
          source: 'custom',
          official_model_id: null,
          thinking_level: 'medium',
          created_at: '2026-06-06T00:00:00.000Z',
          updated_at: '2026-06-06T00:00:00.000Z',
        },
      }),
    ).toBe(false);
  });

  it('filters enabled own and subscribed skills for AI Chat summaries', () => {
    const response: UserSkillsResponse = {
      own: [
        customSkill({ id: 'own-enabled', skill_name: '自有已启用' }),
        customSkill({
          id: 'own-disabled',
          skill_name: '自有未启用',
          enabled: false,
        }),
      ],
      subscribed: [
        subscribedSkill({
          subscription_id: 'sub-enabled',
          skill_name: '订阅已启用',
        }),
        subscribedSkill({
          subscription_id: 'sub-disabled',
          skill_name: '订阅未启用',
          subscription_enabled: false,
        }),
      ],
    };

    expect(getEnabledSkillSummaries(response)).toEqual([
      { id: 'own-enabled', name: '自有已启用', source: 'own' },
      { id: 'sub-enabled', name: '订阅已启用', source: 'subscribed' },
    ]);
  });

  it('resumes to done only after model and skill are both ready', () => {
    expect(
      resolveGuideStep({
        storedStep: 'skill',
        resumeRequested: true,
        modelReady: true,
        skillReady: true,
        modelError: '',
        skillError: '',
      }),
    ).toBe('done');
  });

  it('keeps first-time users on welcome before forcing configuration steps', () => {
    expect(
      resolveGuideStep({
        storedStep: 'welcome',
        resumeRequested: false,
        modelReady: false,
        skillReady: false,
        modelError: '',
        skillError: '',
      }),
    ).toBe('welcome');
  });
});
