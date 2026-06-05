import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetDbPool,
  mockGetSkillMarkdownMetadata,
  mockGetTextSkillBundleContentLength,
  mockReadTextSkillBundleFiles,
  mockWriteTextSkillBundleFiles,
} = vi.hoisted(() => ({
  mockGetDbPool: vi.fn(),
  mockGetSkillMarkdownMetadata: vi.fn(),
  mockGetTextSkillBundleContentLength: vi.fn(),
  mockReadTextSkillBundleFiles: vi.fn(),
  mockWriteTextSkillBundleFiles: vi.fn(),
}));

vi.mock('../db-pool.js', () => ({
  getDbPool: mockGetDbPool,
}));

vi.mock('../../modules/skills/text-skill-bundle-store.js', () => ({
  getSkillMarkdownMetadata: mockGetSkillMarkdownMetadata,
  getTextSkillBundleContentLength: mockGetTextSkillBundleContentLength,
  readTextSkillBundleFiles: mockReadTextSkillBundleFiles,
  writeTextSkillBundleFiles: mockWriteTextSkillBundleFiles,
}));

import {
  createSkillAccessInvite,
  createUserCustomSkill,
  getBundleByToken,
  getEffectiveUserSkills,
  getSkillAccessInvitePreviewByToken,
  getSubscribedSkills,
  redeemSkillAccessInvite,
  getResolvedEnabledOfficialSkillNames,
  listMarketBundles,
  listMarketSkills,
  seedOfficialSkills,
} from './skills-repository.js';

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
    mockGetSkillMarkdownMetadata.mockReturnValue({
      name: 'My Skill',
      description: 'desc',
    });
    mockReadTextSkillBundleFiles.mockReturnValue([
      { path: 'SKILL.md', content: 'skill md' },
      { path: 'docs/knowledge.md', content: 'stored content' },
    ]);
    mockGetTextSkillBundleContentLength.mockReturnValue(14);
    mockWriteTextSkillBundleFiles.mockReturnValue({
      bundleUri: 'text-skill://skill-1',
      checksum: 'checksum-1',
    });
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

  it('reads effective custom skills from self and subscription sources', async () => {
    const { calls } = createMockPool([{ id: 'skill-1' }]);

    await expect(getEffectiveUserSkills('user-1')).resolves.toEqual([
      { id: 'skill-1' },
    ]);

    expect(calls[0]?.sql).toContain("'self' as source");
    expect(calls[0]?.sql).toContain("'subscribed' as source");
    expect(calls[0]?.sql).toContain(
      "sub.source_kind IN ('invite', 'bundle_invite')",
    );
    expect(calls[0]?.params).toEqual(['user-1']);
  });

  it('includes private invite subscriptions in subscribed skill reads', async () => {
    const { calls } = createMockPool([
      { ...skillRow, subscription_id: 'sub-1' },
    ]);

    await getSubscribedSkills('user-1');

    expect(calls[0]?.sql).toContain(
      "sub.source_kind IN ('invite', 'bundle_invite')",
    );
    expect(calls[0]?.params).toEqual(['user-1']);
  });

  it('builds marketplace skill filters and caps list size', async () => {
    const { calls } = createMockPool();

    await listMarketSkills({ limit: 500, offset: 30 });

    expect(calls[0]?.sql).toContain("s.visibility = 'shared'");
    expect(calls[0]?.sql).not.toContain('s.category');
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
    expect(calls[0]?.sql).not.toContain('s2.category');
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

  it('creates custom skills by writing bundle content inside a transaction', async () => {
    const { calls, clientCalls, client } = createMockPool([
      {
        id: 'skill-1',
        bundle_uri: 'text-skill://skill-1',
      },
    ]);

    await expect(
      createUserCustomSkill({
        id: 'skill-1',
        user_id: 'user-1',
        skill_name: 'My Skill',
        dir_name: 'my-skill',
        files: [
          {
            path: 'SKILL.md',
            content: '---\nname: My Skill\ndescription: desc\n---\n',
          },
          { path: 'index.md', content: '# index' },
          { path: 'docs/knowledge.md', content: 'content' },
        ],
      }),
    ).resolves.toEqual({
      id: 'skill-1',
      bundle_uri: 'text-skill://skill-1',
      files: [
        { path: 'SKILL.md', content: 'skill md' },
        { path: 'docs/knowledge.md', content: 'stored content' },
      ],
      content_length: 22,
    });

    expect(mockWriteTextSkillBundleFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: 'skill-1',
        ownerId: 'user-1',
        files: expect.arrayContaining([
          { path: 'docs/knowledge.md', content: 'content' },
        ]),
      }),
    );
    expect(clientCalls[0]?.sql).toBe('BEGIN');
    expect(clientCalls[1]?.sql).toContain('INSERT INTO user_custom_skills');
    expect(clientCalls[1]?.params).toEqual([
      'skill-1',
      'user-1',
      'My Skill',
      'my-skill',
      'desc',
      'text-skill://skill-1',
      'checksum-1',
      expect.any(String),
    ]);
    expect(clientCalls[2]?.sql).toBe('COMMIT');
    expect(calls[0]?.sql).toContain('WHERE s.id = $1');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('loads shared bundle skills in bundle order with content lengths', async () => {
    mockGetTextSkillBundleContentLength.mockImplementation((uri: string) =>
      uri === 'text-skill://skill-2' ? 5 : 2,
    );
    createSequencedMockPool([
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
        },
        {
          id: 'skill-2',
          skill_name: 'Two',
          description: 'second',
          bundle_uri: 'text-skill://skill-2',
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
});
