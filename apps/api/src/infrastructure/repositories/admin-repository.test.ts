import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDbPool, mockReadTextSkillBundleFiles } = vi.hoisted(() => ({
  mockGetDbPool: vi.fn(),
  mockReadTextSkillBundleFiles: vi.fn(),
}));

vi.mock('../db-pool.js', () => ({
  getDbPool: mockGetDbPool,
}));

vi.mock('../../modules/skills/text-skill-bundle-store.js', () => ({
  readTextSkillBundleFiles: mockReadTextSkillBundleFiles,
}));

import {
  getCustomSkillsForAdmin,
  getMessagesForAdmin,
  getTasksForAdmin,
} from './admin-repository.js';

interface QueryCall {
  sql: string;
  params?: unknown[];
}

function createMockPool(results: unknown[][] = [[]]) {
  const calls: QueryCall[] = [];
  let resultIdx = 0;
  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      const rows = results[Math.min(resultIdx, results.length - 1)] ?? [];
      resultIdx += 1;
      return { rows };
    },
  };
  mockGetDbPool.mockReturnValue(pool);
  return { calls };
}

describe('admin repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds admin message filters for user and session scoped reads', async () => {
    const { calls } = createMockPool([[{ cnt: '2' }], [{ id: 'message-1' }]]);

    await expect(
      getMessagesForAdmin({
        userId: 'user-1',
        sessionId: 'session-1',
        limit: 500,
        offset: 20,
      }),
    ).resolves.toEqual({
      messages: [{ id: 'message-1' }],
      total: 2,
    });

    expect(calls[0]?.sql).toContain('m.user_id = $1');
    expect(calls[0]?.sql).toContain('m.session_id = $2');
    expect(calls[0]?.params).toEqual(['user-1', 'session-1']);
    expect(calls[1]?.sql).toContain('LIMIT $3 OFFSET $4');
    expect(calls[1]?.params).toEqual(['user-1', 'session-1', 200, 20]);
  });

  it('caps admin task query limits and keeps filter params ordered', async () => {
    const { calls } = createMockPool();

    await getTasksForAdmin({
      userId: 'user-1',
      status: 'active',
      limit: 9999,
    });

    expect(calls[0]?.sql).toContain('a.owner_id = $1');
    expect(calls[0]?.sql).toContain('t.status = $2');
    expect(calls[0]?.sql).toContain('LIMIT $3');
    expect(calls[0]?.params).toEqual(['user-1', 'active', 2000]);
  });

  it('hydrates custom skill files from bundle storage for admin reads', async () => {
    mockReadTextSkillBundleFiles.mockReturnValue([
      { path: 'SKILL.md', content: 'skill md' },
      { path: 'docs/knowledge.md', content: 'bundle content' },
    ]);
    createMockPool([
      [
        {
          id: 'skill-1',
          bundle_uri: 'text-skill://skill-1',
        },
      ],
    ]);

    await expect(
      getCustomSkillsForAdmin({ userId: 'user-1' }),
    ).resolves.toEqual([
      {
        id: 'skill-1',
        bundle_uri: 'text-skill://skill-1',
        files: [
          { path: 'SKILL.md', content: 'skill md' },
          { path: 'docs/knowledge.md', content: 'bundle content' },
        ],
        content_length: 22,
      },
    ]);

    expect(mockReadTextSkillBundleFiles).toHaveBeenCalledWith(
      'text-skill://skill-1',
    );
  });
});
