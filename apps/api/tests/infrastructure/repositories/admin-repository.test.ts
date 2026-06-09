import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDbPool, mockReadTextSkillBundleFiles } = vi.hoisted(() => ({
  mockGetDbPool: vi.fn(),
  mockReadTextSkillBundleFiles: vi.fn(),
}));

vi.mock('../../../src/infrastructure/db-pool.js', () => ({
  getDbPool: mockGetDbPool,
}));

vi.mock('../../../src/modules/skills/text-skill-bundle-store.js', () => ({
  readTextSkillBundleFiles: mockReadTextSkillBundleFiles,
}));

import {
  getAdminGlobalStats,
  getChatSessionPiArchiveStates,
  getChatSessionPiCleanupCandidates,
  getCustomSkillsForAdmin,
  getMessagesForAdmin,
} from '../../../src/infrastructure/repositories/admin-repository.js';

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

  it('selects Pi cleanup candidates with reusable archive payloads', async () => {
    const { calls } = createMockPool([[{ id: 'session-1' }]]);

    await expect(
      getChatSessionPiCleanupCandidates({
        softDeleted: true,
        limit: 25,
        cursor: 'session-0',
      }),
    ).resolves.toEqual([{ id: 'session-1' }]);

    const sql = calls[0]?.sql ?? '';
    expect(sql).toContain('SELECT id, account_id');
    expect(sql).toContain('pi_session_archive_payload IS NOT NULL');
    expect(sql).toContain('pi_session_archived_at IS NULL');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain("m.status = 'active'");
    expect(calls[0]?.params).toEqual(['session-0', 25]);
  });

  it('selects Pi archive states for orphan cleanup decisions', async () => {
    const { calls } = createMockPool([
      [
        {
          id: 'session-1',
          pi_session_archived_at: null,
          has_pi_session_archive_payload: true,
        },
      ],
    ]);

    await expect(
      getChatSessionPiArchiveStates(['session-1', 'session-1']),
    ).resolves.toEqual([
      {
        id: 'session-1',
        pi_session_archived_at: null,
        has_pi_session_archive_payload: true,
      },
    ]);

    const sql = calls[0]?.sql ?? '';
    expect(sql).toContain('pi_session_archive_payload IS NOT NULL');
    expect(sql).toContain('WHERE id = ANY($1::text[])');
    expect(calls[0]?.params).toEqual([['session-1']]);
  });

  it('builds recharge stats SQL with decimal soft currency columns', async () => {
    const { calls } = createMockPool([
      [{ cnt: '3' }],
      [{ model_source: 'official', count: '2' }],
      [{ total: '2', enabled: '1' }],
      [{ msgs: '10', inp: '100', outp: '200', total: '300' }],
      [{ msgs: '1', inp: '10', outp: '20', total: '30' }],
      [{ cnt: '4' }],
      [
        {
          total_orders: 5,
          paid_orders: 3,
          pending_orders: 1,
          failed_orders: 1,
          paid_users: 2,
          total_coins: 120,
          today_coins: 20,
          period_paid_orders: 2,
          period_paid_users: 2,
          period_coins: 70,
        },
      ],
      [{ active: 2 }],
      [
        {
          purchased: 100,
          bonus: 20,
          reserved: 5,
          available: 115,
          negative_users: 1,
        },
      ],
      [{ held: 3, pending: 4 }],
    ]);

    await expect(
      getAdminGlobalStats({
        rechargeRange: 'custom',
        rechargeStartDate: '2026-05-01',
        rechargeEndDate: '2026-05-30',
      }),
    ).resolves.toMatchObject({
      active_subscriptions: 2,
      failed_recharge_orders: 1,
      paid_recharge_users: 2,
      total_recharge_coins: 120,
      today_recharge_coins: 20,
      held_billing_reservations: 3,
      pending_billing_reservations: 4,
      total_available_coins: 115,
      negative_balance_users: 1,
      recharge_period: {
        range: 'custom',
        start_date: '2026-05-01',
        end_date: '2026-05-30',
        paid_orders: 2,
        paid_users: 2,
        total_recharge_coins: 70,
      },
    });

    const rechargeStatsSql = calls[6]?.sql ?? '';
    expect(rechargeStatsSql).toContain('SUM(amount_coins)');
    expect(rechargeStatsSql).toContain('AS period_coins\n       FROM');
    expect(rechargeStatsSql).not.toContain('amount_cents');
    expect(calls[6]?.params).toEqual([
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      '2026-05-01',
      '2026-05-31',
    ]);
  });
});
