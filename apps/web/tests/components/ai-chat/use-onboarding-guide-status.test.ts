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

const baseModelOverview: ModelSettingsOverview = { model: null };

function officialModel(
  patch: Partial<NonNullable<ModelSettingsOverview['model']>> = {},
): NonNullable<ModelSettingsOverview['model']> {
  return {
    id: 'official-1',
    model_key: 'official-model',
    display_name: 'Official model',
    description: 'Test official model',
    model_name: 'gpt-test',
    context_window_tokens: null,
    input_token_price_per_million_coins: 1,
    output_token_price_per_million_coins: 1,
    has_secret: true,
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
    category: '八字',
    version: '1.0.0',
    bundle_uri: 'file:///skill',
    checksum: null,
    revision_id: null,
    format_version: null,
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
  it('treats the configured official model as ready without user selection', () => {
    expect(hasUsableModelForGuide({ model: officialModel() })).toBe(true);
  });
  it('accepts an enabled benefit-only deployment without sending users to paid-model setup', () => {
    const benefit = {
      model: officialModel(),
      enabled: true,
      supply: 'available' as const,
      daily_turns: 3,
      remaining_turns: 3,
      resets_at: '2026-10-17T00:00:00+08:00',
    };
    expect(hasUsableModelForGuide({ model: null, benefit })).toBe(true);
    expect(
      hasUsableModelForGuide({
        model: null,
        benefit: { ...benefit, enabled: false },
      }),
    ).toBe(false);
  });

  it('keeps the guide unavailable when no official model is configured', () => {
    expect(hasUsableModelForGuide(baseModelOverview)).toBe(false);
    expect(hasUsableModelForGuide(null)).toBe(false);
  });

  it('keeps the guide unavailable when the official model lacks credentials', () => {
    expect(
      hasUsableModelForGuide({ model: officialModel({ has_secret: false }) }),
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
