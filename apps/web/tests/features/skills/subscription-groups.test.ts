import { describe, expect, it } from 'vitest';

import type { SubscribedSkill } from '../../../features/skills/api';
import { groupSubscribedSkills } from '../../../features/skills/subscription-groups';

function skill(
  overrides: Partial<Omit<SubscribedSkill, 'id'>> & Pick<SubscribedSkill, 'id'>,
): SubscribedSkill {
  const { id, ...rest } = overrides;
  return {
    id,
    user_id: 'creator-1',
    skill_name: `skill-${id}`,
    dir_name: `dir-${id}`,
    description: '',
    version: '1.0.0',
    bundle_uri: '/tmp/fateclaw-test-skill',
    checksum: null,
    install_status: 'installed',
    acl: {},
    billing_policy: {},
    audit_metadata: {},
    files: [],
    content_length: 0,
    visibility: 'shared',
    share_token: 'token',
    enabled: true,
    stat_subscriber_count: 0,
    stat_view_count: 0,
    created_at: '2026-05-05T00:00:00.000Z',
    updated_at: '2026-05-05T00:00:00.000Z',
    subscription_id: `sub-${id}`,
    subscription_enabled: true,
    author_label: '匿名作者',
    has_direct_source: true,
    source_bundles: [],
    ...rest,
  };
}

describe('groupSubscribedSkills', () => {
  it('groups bundle-sourced subscriptions and keeps direct subscriptions separate', () => {
    const grouped = groupSubscribedSkills([
      skill({
        id: 'a',
        has_direct_source: false,
        source_bundles: [{ id: 'bundle-1', name: '入门包' }],
      }),
      skill({ id: 'b' }),
      skill({
        id: 'c',
        has_direct_source: false,
        source_bundles: [{ id: 'bundle-1', name: '入门包' }],
      }),
    ]);

    expect(grouped.bundles).toHaveLength(1);
    expect(grouped.bundles[0]).toMatchObject({
      bundleId: 'bundle-1',
      bundleName: '入门包',
    });
    expect(grouped.bundles[0].skills.map((item) => item.id)).toEqual([
      'a',
      'c',
    ]);
    expect(grouped.direct.map((item) => item.id)).toEqual(['b']);
  });
});
