import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockQuery,
  mockEnd,
  mockConnect,
  mockClientQuery,
  mockRelease,
  mockOn,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockEnd: vi.fn(),
  mockConnect: vi.fn(),
  mockClientQuery: vi.fn(),
  mockRelease: vi.fn(),
  mockOn: vi.fn(),
}));

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(function Pool() {
      return {
        query: mockQuery,
        end: mockEnd,
        connect: mockConnect,
        on: mockOn,
      };
    }),
  },
}));

import {
  closeAgentDb,
  queryEffectiveUserSkills,
  querySkillContentRevision,
  updateSoulContentDb,
} from '#agent/agent-db';

describe('agent-db effective user skills', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test/test';
    mockQuery.mockResolvedValue({ rows: [] });
    await closeAgentDb();
  });

  it('treats bundle and invite subscriptions as authorized private skills', async () => {
    await queryEffectiveUserSkills('user-1');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      "sub.source_kind IN ('bundle_share', 'invite', 'bundle_invite')",
    );
    expect(params).toEqual(['user-1']);
  });

  it('loads bundle contents only for the exact authorized revision and excludes deleted skills', async () => {
    const files = [{ path: 'SKILL.md', content: '# Database skill' }];
    mockQuery.mockResolvedValueOnce({
      rows: [{ files, revisionId: 'selected-revision' }],
    });
    expect(
      await querySkillContentRevision('skill-1', 'selected-revision'),
    ).toEqual({ files, revisionId: 'selected-revision' });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('r.id = $2 AND s.deleted_at IS NULL');
    expect(params).toEqual(['skill-1', 'selected-revision']);
    expect(
      await querySkillContentRevision('skill-1', 'stale-checksum'),
    ).toBeNull();
  });
});

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

describe('atomic Soul updates', () => {
  beforeEach(async () => {
    await closeAgentDb();
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test/test';
    mockClientQuery.mockReset();
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockConnect.mockResolvedValue({
      query: mockClientQuery,
      release: mockRelease,
    });
  });

  it('rolls back stale reads without executing an update', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ soul_content: 'Dashboard edit' }] });
    expect(
      await updateSoulContentDb('web:user-1', 'replacement', hash('old')),
    ).toBe(false);
    expect(
      mockClientQuery.mock.calls.some(([sql]) => sql.startsWith('UPDATE')),
    ).toBe(false);
    expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledWith(false);
  });

  it('locks the web fallback source and writes the user canonical source', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ soul_content: '' }] })
      .mockResolvedValueOnce({ rows: [{ soul_content: 'legacy' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    expect(await updateSoulContentDb('web:user-1', 'new', hash('legacy'))).toBe(
      true,
    );
    expect(mockClientQuery.mock.calls[1][0]).toContain('FOR UPDATE');
    expect(mockClientQuery.mock.calls[2][0]).toContain(
      'ORDER BY enabled DESC, created_at ASC',
    );
    expect(mockClientQuery.mock.calls[2][0]).toContain('FOR UPDATE');
    expect(mockClientQuery).toHaveBeenCalledWith(
      'UPDATE users SET soul_content = $2 WHERE id = $1',
      ['user-1', 'new'],
    );
    expect(mockClientQuery).toHaveBeenLastCalledWith('COMMIT');
  });

  it('preserves account Soul fallback for an ownerless legacy account', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'account-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ account_soul_content: 'legacy', user_soul_content: null }],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    expect(await updateSoulContentDb('account-1', 'new', hash('legacy'))).toBe(
      true,
    );
    expect(mockClientQuery).toHaveBeenCalledWith(
      'UPDATE accounts SET soul_content = $2 WHERE id = $1',
      ['account-1', 'new'],
    );
  });

  it.each(['40001', '40P01'])(
    'surfaces PostgreSQL concurrency failure %s as a conflict',
    async (code) => {
      mockClientQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(
          Object.assign(new Error('synthetic conflict'), { code }),
        );
      expect(await updateSoulContentDb('web:user-1', 'new', hash('old'))).toBe(
        false,
      );
      expect(mockClientQuery).toHaveBeenLastCalledWith('ROLLBACK');
      expect(mockRelease).toHaveBeenCalledWith(false);
    },
  );

  it('does not claim a write succeeded when the user no longer exists', async () => {
    expect(await updateSoulContentDb('web:missing', 'new', hash(''))).toBe(
      false,
    );
  });

  it('propagates database failure and discards a client whose rollback failed', async () => {
    const failure = new Error('synthetic disconnect');
    mockClientQuery.mockRejectedValue(failure);
    await expect(
      updateSoulContentDb('web:user-1', 'new', hash('old')),
    ).rejects.toBe(failure);
    expect(mockRelease).toHaveBeenCalledWith(true);
  });
});
