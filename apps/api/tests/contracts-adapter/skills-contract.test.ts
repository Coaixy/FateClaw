import { describe, expect, it } from 'vitest';

import { toSubscribedSkillDto } from '#contracts-adapter/skills-contract';
import type { UserCustomSkill } from '#shared/types';

function customSkill(): UserCustomSkill {
  return {
    id: 'skill-1',
    user_id: 'creator-1',
    skill_name: '六爻入门',
    dir_name: 'liuyao',
    description: '',
    version: '1.0.0',
    bundle_uri: '/tmp/fateclaw-test-skill',
    checksum: null,
    revision_id: null,
    format_version: null,
    install_status: 'installed',
    acl: {},
    billing_policy: {},
    audit_metadata: {},
    files: [],
    content_length: 0,
    visibility: 'shared',
    share_token: 'token',
    enabled: true,
    stat_subscriber_count: 1,
    stat_view_count: 0,
    created_at: '2026-05-05T00:00:00.000Z',
    updated_at: '2026-05-05T00:00:00.000Z',
    deleted_at: null,
  };
}

describe('toSubscribedSkillDto', () => {
  it('preserves bundle source metadata for grouped unsubscribe UI', () => {
    const dto = toSubscribedSkillDto({
      ...customSkill(),
      subscription_id: 'sub-1',
      subscription_enabled: true,
      has_direct_source: false,
      source_bundles: [{ id: 'bundle-1', name: '六爻基础包' }],
    });

    expect(dto).toMatchObject({
      subscription_id: 'sub-1',
      has_direct_source: false,
      source_bundles: [{ id: 'bundle-1', name: '六爻基础包' }],
    });
  });
});
