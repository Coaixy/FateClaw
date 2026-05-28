import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetDbPool,
  mockReadTextSkillBundleContent,
  mockWriteTextSkillBundle,
} = vi.hoisted(() => ({
  mockGetDbPool: vi.fn(),
  mockReadTextSkillBundleContent: vi.fn(),
  mockWriteTextSkillBundle: vi.fn(),
}));

vi.mock('../db-pool.js', () => ({
  getDbPool: mockGetDbPool,
}));

vi.mock('../../modules/skills/text-skill-bundle-store.js', () => ({
  readTextSkillBundleContent: mockReadTextSkillBundleContent,
  writeTextSkillBundle: mockWriteTextSkillBundle,
}));

import {
  createUserCustomSkill,
  getBundleByToken,
  getEffectiveUserSkills,
  getResolvedEnabledOfficialSkillNames,
  listMarketBundles,
  listMarketSkills,
  seedOfficialSkills,
  upsertCreatorBundleConfig,
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

describe('skills repository official skill settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadTextSkillBundleContent.mockReturnValue('stored content');
    mockWriteTextSkillBundle.mockReturnValue({
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
    expect(calls[0]?.params).toEqual(['user-1']);
  });

  it('builds marketplace skill filters and caps list size', async () => {
    const { calls } = createMockPool();

    await listMarketSkills({ category: '命理', limit: 500, offset: 30 });

    expect(calls[0]?.sql).toContain("s.visibility = 'shared'");
    expect(calls[0]?.sql).toContain('s.category = $1');
    expect(calls[0]?.sql).toContain('LIMIT $2 OFFSET $3');
    expect(calls[0]?.params).toEqual(['命理', 100, 30]);
  });

  it('builds marketplace bundle filters and caps list size', async () => {
    const { calls } = createMockPool();

    await listMarketBundles({ category: '命理', limit: 500, offset: 10 });

    expect(calls[0]?.sql).toContain("b.visibility = 'shared'");
    expect(calls[0]?.sql).toContain('s2.category = $1');
    expect(calls[0]?.sql).toContain('LIMIT $2 OFFSET $3');
    expect(calls[0]?.params).toEqual(['命理', 50, 10]);
  });

  it('serializes creator bundle tiers when upserting config', async () => {
    const { calls } = createMockPool();

    await upsertCreatorBundleConfig('creator-1', [{ key: 'monthly' }]);

    expect(calls[0]?.sql).toContain('INSERT INTO creator_bundle_config');
    expect(calls[0]?.params).toEqual([
      'creator-1',
      JSON.stringify([{ key: 'monthly' }]),
    ]);
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
        description: 'desc',
        trigger_hint: 'hint',
        content: 'content',
        category: '通用',
      }),
    ).resolves.toEqual({
      id: 'skill-1',
      bundle_uri: 'text-skill://skill-1',
      content: 'stored content',
    });

    expect(mockWriteTextSkillBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: 'skill-1',
        ownerId: 'user-1',
        content: 'content',
      }),
    );
    expect(clientCalls[0]?.sql).toBe('BEGIN');
    expect(clientCalls[1]?.sql).toContain('INSERT INTO user_custom_skills');
    expect(clientCalls[1]?.params?.slice(0, 8)).toEqual([
      'skill-1',
      'user-1',
      'My Skill',
      'my-skill',
      'desc',
      'hint',
      'text-skill://skill-1',
      'checksum-1',
    ]);
    expect(clientCalls[2]?.sql).toBe('COMMIT');
    expect(calls[0]?.sql).toContain('WHERE s.id = $1');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('loads shared bundle skills in bundle order with content lengths', async () => {
    mockReadTextSkillBundleContent.mockImplementation((uri: string) =>
      uri === 'text-skill://skill-2' ? '12345' : '12',
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
          category: '通用',
          bundle_uri: 'text-skill://skill-1',
        },
        {
          id: 'skill-2',
          skill_name: 'Two',
          description: 'second',
          category: '命理',
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
});
