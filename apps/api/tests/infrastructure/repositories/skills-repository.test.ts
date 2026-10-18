import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDbPool } = vi.hoisted(() => ({ mockGetDbPool: vi.fn() }));
vi.mock('#infrastructure/db-pool', () => ({
  getDbPool: mockGetDbPool,
}));

import {
  createSkillAccessInvite,
  createUserCustomSkill,
  deleteUserCustomSkill,
  getBundleByToken,
  getUserCustomSkill,
  getSkillAccessInvitePreviewByToken,
  getSubscribedSkills,
  redeemSkillAccessInvite,
  getResolvedEnabledOfficialSkillNames,
  listSkillCommentsForAdmin,
  listMarketBundles,
  listMarketSkills,
  listUserBundles,
  reviewSkillCommentForAdmin,
  seedOfficialSkills,
  setSkillCommentPinnedForAdmin,
  subscribeToBundle,
  unsubscribeFromSkill,
} from '#infrastructure/repositories/skills-repository';

interface QueryCall {
  sql: string;
  params?: unknown[];
}

function createMockPool(rows: unknown[] = []) {
  const calls: QueryCall[] = [];
  const clientCalls: QueryCall[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      clientCalls.push({ sql, params });
      return { rows };
    },
    release: vi.fn(),
  };
  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return { rows };
    },
    async connect() {
      return client;
    },
  };
  mockGetDbPool.mockReturnValue(pool);
  return { calls, clientCalls, client };
}

function createSequencedMockPool(poolRows: unknown[][]) {
  const calls: QueryCall[] = [];
  let idx = 0;
  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      const rows = poolRows[Math.min(idx, poolRows.length - 1)] ?? [];
      idx += 1;
      return { rows, rowCount: rows.length };
    },
  };
  mockGetDbPool.mockReturnValue(pool);
  return { calls };
}

function createSequencedClientMockPool(clientRows: unknown[][]) {
  const calls: QueryCall[] = [];
  const clientCalls: QueryCall[] = [];
  let idx = 0;
  const client = {
    async query(sql: string, params?: unknown[]) {
      clientCalls.push({ sql, params });
      const rows = clientRows[Math.min(idx, clientRows.length - 1)] ?? [];
      idx += 1;
      return { rows, rowCount: rows.length };
    },
    release: vi.fn(),
  };
  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return client;
    },
  };
  mockGetDbPool.mockReturnValue(pool);
  return { calls, clientCalls, client };
}

function createSequencedPoolAndClientMockPool(input: {
  poolRows: unknown[][];
  clientRows: unknown[][];
}) {
  const calls: QueryCall[] = [];
  const clientCalls: QueryCall[] = [];
  let poolIdx = 0;
  let clientIdx = 0;
  const client = {
    async query(sql: string, params?: unknown[]) {
      clientCalls.push({ sql, params });
      const rows =
        input.clientRows[Math.min(clientIdx, input.clientRows.length - 1)] ??
        [];
      clientIdx += 1;
      return { rows, rowCount: rows.length };
    },
    release: vi.fn(),
  };
  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      const rows =
        input.poolRows[Math.min(poolIdx, input.poolRows.length - 1)] ?? [];
      poolIdx += 1;
      return { rows, rowCount: rows.length };
    },
    async connect() {
      return client;
    },
  };
  mockGetDbPool.mockReturnValue(pool);
  return { calls, clientCalls, client };
}

const skillRow = {
  id: 'skill-1',
  user_id: 'creator-1',
  skill_name: 'Invite Skill',
  dir_name: 'invite-skill',
  description: 'desc',
  version: '1.0.0',
  bundle_uri: 'text-skill://skill-1',
  checksum: null,
  install_status: 'installed',
  acl: {},
  billing_policy: {},
  audit_metadata: {},
  visibility: 'private',
  share_token: null,
  enabled: true,
  stat_subscriber_count: 0,
  stat_view_count: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  deleted_at: null,
};

const inviteRow = {
  id: 'invite-1',
  creator_id: 'creator-1',
  target_type: 'skill',
  target_id: 'skill-1',
  token: 'invite-token',
  max_redemptions: 1,
  redeemed_count: 0,
  expires_at: null,
  revoked_at: null,
  note: '',
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('skills repository official skill settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('seeds official skills and removes stale global config rows transactionally', async () => {
    const { clientCalls, client } = createMockPool();

    await seedOfficialSkills(['bazi', 'ziwei']);

    expect(clientCalls[0]?.sql).toBe('BEGIN');
    expect(clientCalls[1]?.sql).toContain('INSERT INTO skill_global_config');
    expect(clientCalls[1]?.params).toEqual(['bazi']);
    expect(clientCalls[2]?.params).toEqual(['ziwei']);
    expect(clientCalls[3]?.sql).toContain(
      'DELETE FROM skill_global_config WHERE skill_name NOT IN ($1,$2)',
    );
    expect(clientCalls[3]?.params).toEqual(['bazi', 'ziwei']);
    expect(clientCalls[4]?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('skips seeding when the official skill list is empty', async () => {
    const { calls, clientCalls } = createMockPool();

    await seedOfficialSkills([]);

    expect(calls).toEqual([]);
    expect(clientCalls).toEqual([]);
  });

  it('resolves official skill enablement from global switches', async () => {
    const { calls } = createMockPool([{ skill_name: 'bazi' }]);

    await expect(
      getResolvedEnabledOfficialSkillNames('user-1'),
    ).resolves.toEqual(['bazi']);

    expect(calls[0]?.sql).toContain('globally_enabled = true');
    expect(calls[0]?.sql).not.toContain('user_skills');
    expect(calls[0]?.params).toBeUndefined();
  });

  it('resolves anonymous official skill enablement from global switches', async () => {
    const { calls } = createMockPool([{ skill_name: 'ziwei' }]);

    await expect(getResolvedEnabledOfficialSkillNames()).resolves.toEqual([
      'ziwei',
    ]);

    expect(calls[0]?.sql).toContain('globally_enabled = true');
    expect(calls[0]?.sql).not.toContain('default_enabled');
    expect(calls[0]?.params).toBeUndefined();
  });

  it('includes private invite subscriptions in subscribed skill reads', async () => {
    const { calls } = createMockPool([
      { ...skillRow, subscription_id: 'sub-1' },
    ]);

    await getSubscribedSkills('user-1');

    expect(calls[0]?.sql).toContain(
      "sub.source_kind IN ('bundle_share', 'invite', 'bundle_invite')",
    );
    expect(calls[0]?.params).toEqual(['user-1']);
  });

  it('builds marketplace skill filters and caps list size', async () => {
    const { calls } = createMockPool();

    await listMarketSkills({ limit: 500, offset: 30 });

    expect(calls[0]?.sql).toContain("s.visibility = 'shared'");
    // 市场查询现需带回 category 以支持 discover 按术数门类筛选（复活初版分类维度）。
    expect(calls[0]?.sql).toContain('s.category');
    expect(calls[0]?.sql).toContain('LIMIT $1 OFFSET $2');
    expect(calls[0]?.params).toEqual([100, 30]);
  });

  it('clamps unsafe marketplace skill offsets defensively', async () => {
    const { calls } = createMockPool();

    await listMarketSkills({ limit: 50, offset: -10 });
    await listMarketSkills({ limit: 50, offset: 99_999 });

    expect(calls[0]?.params).toEqual([50, 0]);
    expect(calls[1]?.params).toEqual([50, 10_000]);
  });

  it('builds marketplace bundle filters and caps list size', async () => {
    const { calls } = createMockPool();

    await listMarketBundles({ limit: 500, offset: 10 });

    expect(calls[0]?.sql).toContain("b.visibility = 'shared'");
    expect(calls[0]?.sql).not.toContain('s.visibility');
    expect(calls[0]?.sql).not.toContain('s2.category');
    expect(calls[0]?.sql).toContain('b.stat_skill_count::int AS skill_count');
    expect(calls[0]?.sql).toContain('b.stat_skill_count > 0');
    expect(calls[0]?.sql).toContain('LIMIT $1 OFFSET $2');
    expect(calls[0]?.params).toEqual([50, 10]);
  });

  it('clamps unsafe marketplace bundle offsets defensively', async () => {
    const { calls } = createMockPool();

    await listMarketBundles({ limit: 20, offset: -10 });
    await listMarketBundles({ limit: 20, offset: 99_999 });

    expect(calls[0]?.params).toEqual([20, 0]);
    expect(calls[1]?.params).toEqual([20, 10_000]);
  });

  it('commits complete custom skill files with their metadata without writing local files', async () => {
    const files = [
      {
        path: 'SKILL.md',
        content: '---\nname: My Skill\ndescription: desc\n---\n',
      },
      { path: 'docs/knowledge.md', content: 'content' },
      { path: 'index.md', content: '# index' },
    ];
    const { calls, clientCalls, client } = createMockPool([
      {
        id: 'skill-1',
        bundle_uri: 'db://user-custom-skills/skill-1',
        files,
      },
    ]);

    await expect(
      createUserCustomSkill({
        id: 'skill-1',
        user_id: 'user-1',
        skill_name: 'My Skill',
        dir_name: 'my-skill',
        files,
      }),
    ).resolves.toEqual({
      id: 'skill-1',
      bundle_uri: 'db://user-custom-skills/skill-1',
      files,
      content_length: files.reduce((sum, file) => sum + file.content.length, 0),
    });

    expect(clientCalls[0]?.sql).toBe('BEGIN');
    expect(clientCalls[1]?.sql).toContain('INSERT INTO user_custom_skills');
    expect(clientCalls[2]?.sql).toContain(
      'INSERT INTO skill_content_revisions',
    );
    expect(clientCalls[2]?.params).toEqual([
      expect.any(String),
      'skill-1',
      1,
      expect.stringMatching(/^[a-f0-9]{64}$/),
      JSON.stringify(files),
      files.reduce((sum, file) => sum + file.content.length, 0),
    ]);
    expect(clientCalls[3]?.sql).toContain('current_revision_id');
    expect(clientCalls[4]?.sql).toBe('COMMIT');
    expect(calls[0]?.sql).toContain('WHERE s.id = $1');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('reads canonical database files even when this deployment has no local bundle', async () => {
    const files = [{ path: 'SKILL.md', content: '# Database skill' }];
    createMockPool([{ ...skillRow, files }]);

    const skill = await getUserCustomSkill('skill-1', 'creator-1');

    expect(skill?.files).toEqual(files);
    expect(skill?.content_length).toBe(files[0].content.length);
  });

  it('loads shared bundle skills in bundle order with content lengths', async () => {
    const { calls } = createSequencedMockPool([
      [
        {
          id: 'bundle-1',
          user_id: 'creator-1',
          skill_ids: ['skill-2', 'skill-1'],
        },
      ],
      [
        {
          id: 'skill-1',
          skill_name: 'One',
          description: 'first',
          bundle_uri: 'text-skill://skill-1',
          content_length: 2,
        },
        {
          id: 'skill-2',
          skill_name: 'Two',
          description: 'second',
          bundle_uri: 'text-skill://skill-2',
          content_length: 5,
        },
      ],
    ]);

    await expect(getBundleByToken('token-1')).resolves.toMatchObject({
      bundle: {
        id: 'bundle-1',
        skill_ids: ['skill-2', 'skill-1'],
      },
      skills: [
        { id: 'skill-2', content_length: 5 },
        { id: 'skill-1', content_length: 2 },
      ],
    });
    expect(calls[1]?.sql).not.toContain('s.visibility');
  });

  it('creates access invites for owned skills only', async () => {
    const { calls } = createSequencedMockPool([[skillRow], [inviteRow]]);

    await expect(
      createSkillAccessInvite({
        id: 'invite-1',
        creatorId: 'creator-1',
        targetType: 'skill',
        targetId: 'skill-1',
        token: 'invite-token',
        maxRedemptions: 1,
        expiresAt: null,
        note: '',
      }),
    ).resolves.toMatchObject({ id: 'invite-1', token: 'invite-token' });

    expect(calls[0]?.sql).toContain('WHERE s.id = $1 AND s.user_id = $2');
    expect(calls[1]?.sql).toContain('INSERT INTO skill_access_invites');
  });

  it('previews private skill access invites without requiring share visibility', async () => {
    const { calls } = createSequencedMockPool([[inviteRow], [skillRow]]);

    await expect(
      getSkillAccessInvitePreviewByToken('invite-token'),
    ).resolves.toMatchObject({
      status: 'active',
      skill: { id: 'skill-1', visibility: 'private' },
    });

    expect(calls[1]?.sql).toContain('WHERE s.id = $1 AND s.deleted_at IS NULL');
    expect(calls[1]?.sql).not.toContain(
      "s.visibility IN ('link_shared', 'shared')",
    );
  });

  it('redeems private skill invites into invite-sourced subscriptions', async () => {
    const { clientCalls, client } = createSequencedClientMockPool([
      [],
      [inviteRow],
      [skillRow],
      [{ id: 'sub-1', is_insert: true }],
      [],
      [],
      [],
    ]);

    await expect(
      redeemSkillAccessInvite('user-1', 'invite-token'),
    ).resolves.toEqual({
      status: 'redeemed',
      targetType: 'skill',
      subscribedCount: 1,
      skippedCount: 0,
      subscriptionIds: ['sub-1'],
    });

    expect(clientCalls[0]?.sql).toBe('BEGIN');
    expect(clientCalls[3]?.sql).toContain("source_kind = 'invite'");
    expect(clientCalls[5]?.sql).toContain(
      'redeemed_count = redeemed_count + 1',
    );
    expect(clientCalls[6]?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('redeems private bundle invites into bundle-invite subscriptions', async () => {
    const bundleInvite = {
      ...inviteRow,
      target_type: 'bundle',
      target_id: 'bundle-1',
    };
    const { clientCalls } = createSequencedClientMockPool([
      [],
      [bundleInvite],
      [
        {
          id: 'bundle-1',
          user_id: 'creator-1',
          name: 'Private Bundle',
          description: '',
          skill_ids: ['skill-1'],
        },
      ],
      [
        {
          id: 'skill-1',
          skill_name: 'Invite Skill',
          description: 'desc',
          bundle_uri: 'text-skill://skill-1',
          content_length: 2,
        },
      ],
      [{ id: 'sub-1', is_insert: true }],
      [],
      [],
      [],
      [],
    ]);

    await expect(
      redeemSkillAccessInvite('user-1', 'bundle-invite-token'),
    ).resolves.toMatchObject({
      status: 'redeemed',
      targetType: 'bundle',
      subscribedCount: 1,
      subscriptionIds: ['sub-1'],
    });

    expect(clientCalls[4]?.sql).toContain("'bundle_invite'");
    expect(clientCalls[5]?.sql).toContain(
      'INSERT INTO user_skill_subscription_bundle_sources',
    );
  });

  it('reactivates existing subscriptions when subscribing to public bundles', async () => {
    const { clientCalls } = createSequencedPoolAndClientMockPool({
      poolRows: [
        [
          {
            id: 'bundle-1',
            user_id: 'creator-1',
            skill_ids: ['skill-1'],
          },
        ],
        [
          {
            id: 'skill-1',
            skill_name: 'Skill',
            description: '',
            bundle_uri: 'text-skill://skill-1',
          },
        ],
      ],
      // BEGIN → FOR SHARE 存活重校验（关闭 TOCTOU）→ INSERT ON CONFLICT → INSERT sources → COMMIT
      clientRows: [
        [],
        [{ id: 'bundle-1' }],
        [{ id: 'sub-1', is_insert: false }],
        [],
        [],
      ],
    });

    await subscribeToBundle('user-1', 'bundle-token');

    expect(clientCalls[1]?.sql).toContain('FOR SHARE');
    expect(clientCalls[2]?.sql).toContain(
      'ON CONFLICT (subscriber_id, skill_id) DO UPDATE SET',
    );
    expect(clientCalls[2]?.sql).toContain('enabled = true');
    expect(clientCalls[2]?.sql).toContain("status = 'active'");
    expect(clientCalls[3]?.sql).toContain(
      'INSERT INTO user_skill_subscription_bundle_sources',
    );
  });

  it('keeps bundle-sourced access when removing direct skill subscriptions', async () => {
    const { clientCalls } = createSequencedClientMockPool([
      [],
      [{ id: 'sub-1', skill_id: 'skill-1', has_direct_source: true }],
      [{ exists: 1 }],
      [],
      [],
    ]);

    await expect(unsubscribeFromSkill('sub-1', 'user-1')).resolves.toBe(true);

    expect(clientCalls[1]?.sql).toContain('FOR UPDATE');
    expect(clientCalls[3]?.sql).toContain('SET has_direct_source = false');
    expect(
      clientCalls.some((call) =>
        call.sql.includes('DELETE FROM user_skill_subscriptions'),
      ),
    ).toBe(false);
  });

  it('builds admin comment review filters and returns submitter audit data', async () => {
    const { calls } = createMockPool([
      {
        id: 'comment-1',
        skill_id: 'skill-1',
        skill_name: '公开 Skill',
        user_id: 'user-1',
        user_phone: '13800000000',
        body: '评论内容',
        status: 'pending',
        pinned: false,
        reviewed_by: null,
        reviewed_at: null,
        created_at: '2026-06-12T00:00:00.000Z',
        updated_at: '2026-06-12T00:00:00.000Z',
      },
    ]);

    await expect(
      listSkillCommentsForAdmin({
        status: 'pending',
        skillId: 'skill-1',
        limit: 250,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        user_id: 'user-1',
        user_phone: '13800000000',
      }),
    ]);

    expect(calls[0]?.sql).toContain('LEFT JOIN users u ON u.id = c.user_id');
    expect(calls[0]?.sql).toContain('c.status = $1');
    expect(calls[0]?.sql).toContain('c.skill_id = $2');
    expect(calls[0]?.params).toEqual(['pending', 'skill-1', 200]);
  });

  it('reviews comments and clears pinned state when rejected', async () => {
    const { calls } = createMockPool([
      {
        id: 'comment-1',
        skill_id: 'skill-1',
        skill_name: '公开 Skill',
        user_id: 'user-1',
        user_phone: null,
        body: '评论内容',
        status: 'rejected',
        pinned: false,
        reviewed_by: 'owner',
        reviewed_at: '2026-06-13T00:00:00.000Z',
        created_at: '2026-06-12T00:00:00.000Z',
        updated_at: '2026-06-13T00:00:00.000Z',
      },
    ]);

    await expect(
      reviewSkillCommentForAdmin({
        id: 'comment-1',
        status: 'rejected',
        reviewedBy: 'owner',
      }),
    ).resolves.toMatchObject({
      id: 'comment-1',
      status: 'rejected',
      pinned: false,
    });

    expect(calls[0]?.sql).toContain('pinned = false');
    expect(calls[0]?.params).toEqual(['comment-1', 'rejected', 'owner']);
  });

  it('pins only approved comments in the repository update', async () => {
    const { calls } = createMockPool([
      {
        id: 'comment-1',
        skill_id: 'skill-1',
        skill_name: '公开 Skill',
        user_id: 'user-1',
        user_phone: null,
        body: '评论内容',
        status: 'approved',
        pinned: true,
        reviewed_by: 'owner',
        reviewed_at: '2026-06-13T00:00:00.000Z',
        created_at: '2026-06-12T00:00:00.000Z',
        updated_at: '2026-06-13T00:00:00.000Z',
      },
    ]);

    await expect(
      setSkillCommentPinnedForAdmin('comment-1', true),
    ).resolves.toMatchObject({
      id: 'comment-1',
      pinned: true,
    });

    expect(calls[0]?.sql).toContain("WHERE id = $1 AND status = 'approved'");
    expect(calls[0]?.params).toEqual(['comment-1', true]);
  });

  it('excludes deleted skills from bundle skill_ids so stale ids never reach the edit form', async () => {
    const { calls } = createMockPool([
      {
        id: 'bundle-1',
        user_id: 'user-1',
        name: 'Bundle',
        description: '',
        skill_ids: ['skill-1'],
        bundle_token: null,
        visibility: 'private',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        deleted_at: null,
      },
    ]);

    await listUserBundles('user-1');

    expect(calls[0]?.sql).toContain(
      'JOIN user_custom_skills s ON s.id = sbi.skill_id AND s.deleted_at IS NULL',
    );
  });

  it('cleans up bundle membership and recomputes stat_skill_count when a skill is deleted', async () => {
    const { clientCalls, client } = createSequencedClientMockPool([
      [{}], // UPDATE user_custom_skills ... 命中一行
      [{ bundle_id: 'bundle-1' }], // WITH removed AS (DELETE ...) 清理关联行
    ]);

    await expect(deleteUserCustomSkill('skill-1', 'user-1')).resolves.toBe(
      true,
    );

    expect(clientCalls[0]?.sql).toBe('BEGIN');
    expect(clientCalls[1]?.sql).toContain('UPDATE user_custom_skills');
    expect(clientCalls[2]?.sql).toContain(
      'DELETE FROM skill_bundle_items WHERE skill_id = $1',
    );
    expect(clientCalls[2]?.sql).toContain('SET stat_skill_count = (');
    expect(clientCalls[2]?.params).toEqual(['skill-1']);
    expect(clientCalls[3]?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('skips bundle cleanup when the skill delete matches no row', async () => {
    const { clientCalls } = createSequencedClientMockPool([[]]);

    await expect(deleteUserCustomSkill('skill-1', 'user-1')).resolves.toBe(
      false,
    );

    expect(clientCalls.map((c) => c.sql)).toEqual([
      'BEGIN',
      expect.stringContaining('UPDATE user_custom_skills'),
      'COMMIT',
    ]);
  });
});
