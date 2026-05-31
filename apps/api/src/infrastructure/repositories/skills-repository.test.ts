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
  createUserCustomSkill,
  getBundleByToken,
  getEffectiveUserSkills,
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

  it('builds marketplace bundle filters and caps list size', async () => {
    const { calls } = createMockPool();

    await listMarketBundles({ limit: 500, offset: 10 });

    expect(calls[0]?.sql).toContain("b.visibility = 'shared'");
    expect(calls[0]?.sql).not.toContain('s2.category');
    expect(calls[0]?.sql).toContain('LIMIT $1 OFFSET $2');
    expect(calls[0]?.params).toEqual([50, 10]);
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
});
