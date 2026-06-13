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
  queryWorkflowBundleSkills,
  queryWorkflowSnapshotSkills,
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
    expect(params).toEqual([
      'user-1',
      null,
      'simple_workflow_snapshot',
    ]);
  });

  it('keeps workflow snapshots out of normal and bundle-scoped skill reads', async () => {
    await queryEffectiveUserSkills('user-1');
    await queryWorkflowBundleSkills(['bundle-1']);

    const normalSql = mockQuery.mock.calls[0]?.[0] as string;
    const normalParams = mockQuery.mock.calls[0]?.[1] as unknown[];
    const bundleSql = mockQuery.mock.calls[1]?.[0] as string;
    const bundleParams = mockQuery.mock.calls[1]?.[1] as unknown[];

    expect(normalSql).toContain(
      "COALESCE(s.audit_metadata->>'source', '') <> $3",
    );
    expect(normalParams).toEqual([
      'user-1',
      null,
      'simple_workflow_snapshot',
    ]);
    expect(bundleSql).toContain(
      "COALESCE(s.audit_metadata->>'source', '') <> $2",
    );
    expect(bundleParams).toEqual([
      ['bundle-1'],
      'simple_workflow_snapshot',
    ]);
  });

  it('loads only rows explicitly marked as workflow snapshots for snapshot scopes', async () => {
    await queryWorkflowSnapshotSkills(['snapshot-1']);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("s.audit_metadata->>'source' = $2");
    expect(params).toEqual([
      ['snapshot-1'],
      'simple_workflow_snapshot',
    ]);
  });
});
