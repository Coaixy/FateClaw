import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, mockEnd } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockEnd: vi.fn(),
}));

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(function Pool() {
      return {
      query: mockQuery,
      end: mockEnd,
      };
    }),
  },
}));

import {
  closeAgentDb,
  queryEffectiveUserSkills,
} from '../src/agent-db.js';

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
    expect(params).toEqual(['user-1', null]);
  });
});
