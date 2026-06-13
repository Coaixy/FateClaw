import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDbPool } = vi.hoisted(() => ({
  mockGetDbPool: vi.fn(),
}));

vi.mock('../../../src/infrastructure/db-pool.js', () => ({
  getDbPool: mockGetDbPool,
}));

import {
  createAnnouncement,
  deleteDraftAnnouncement,
  getActiveAnnouncement,
  listPublicAnnouncements,
  updateAnnouncement,
} from '../../../src/infrastructure/repositories/announcements-repository.js';

interface QueryCall {
  sql: string;
  params?: unknown[];
}

type MockQueryResult = unknown[] | { rows?: unknown[]; rowCount?: number };

function normalizeResult(result: MockQueryResult | undefined) {
  if (Array.isArray(result)) return { rows: result, rowCount: result.length };
  return {
    rows: result?.rows ?? [],
    rowCount: result?.rowCount ?? result?.rows?.length ?? 0,
  };
}

function createMockPool(results: MockQueryResult[] = []) {
  const calls: QueryCall[] = [];
  let resultIdx = 0;
  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return normalizeResult(results[resultIdx++]);
    },
  };
  mockGetDbPool.mockReturnValue(pool);
  return { calls };
}

function announcementRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'announcement-1',
    slug: 'maintenance',
    title: '维护公告',
    summary: '今晚维护',
    body_markdown: '今晚 23:00 维护',
    status: 'published',
    priority: '10',
    starts_at: null,
    ends_at: null,
    cta_label: null,
    cta_href: null,
    published_at: '2026-06-12T00:00:00.000Z',
    created_at: '2026-06-12T00:00:00.000Z',
    updated_at: '2026-06-12T00:00:00.000Z',
    ...overrides,
  };
}

describe('announcements repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists public announcements after their start time', async () => {
    const { calls } = createMockPool([[announcementRow()]]);

    await expect(listPublicAnnouncements()).resolves.toEqual([
      expect.objectContaining({
        id: 'announcement-1',
        priority: 10,
      }),
    ]);

    expect(calls[0]?.sql).toContain("status = 'published'");
    expect(calls[0]?.sql).toContain('starts_at IS NULL OR starts_at <= NOW()');
    expect(calls[0]?.sql).toContain('ORDER BY published_at DESC NULLS LAST');
  });

  it('selects the active announcement by priority and publish time', async () => {
    const { calls } = createMockPool([[announcementRow()]]);

    await expect(getActiveAnnouncement()).resolves.toMatchObject({
      id: 'announcement-1',
      priority: 10,
    });

    expect(calls[0]?.sql).toContain('ends_at IS NULL OR ends_at > NOW()');
    expect(calls[0]?.sql).toContain('ORDER BY priority DESC');
    expect(calls[0]?.sql).toContain('LIMIT 1');
  });

  it('creates published announcements with generated ids and published time', async () => {
    const { calls } = createMockPool([[announcementRow()]]);

    await createAnnouncement({
      title: '维护公告',
      summary: '今晚维护',
      bodyMarkdown: '今晚 23:00 维护',
      status: 'published',
      priority: 10,
      startsAt: null,
      endsAt: null,
      ctaLabel: null,
      ctaHref: null,
    });

    expect(calls[0]?.sql).toContain('INSERT INTO announcements');
    expect(calls[0]?.params).toEqual([
      expect.stringMatching(/^announcement-/),
      expect.stringMatching(/^announcement-[0-9a-f-]+$/),
      '维护公告',
      '今晚维护',
      '今晚 23:00 维护',
      'published',
      10,
      null,
      null,
      null,
      null,
      expect.any(String),
    ]);
  });

  it('keeps undefined fields but clears explicit null values on update', async () => {
    const { calls } = createMockPool([
      [
        announcementRow({
          cta_label: '查看',
          cta_href: '/wallet',
          starts_at: '2026-06-12T00:00:00.000Z',
        }),
      ],
      [
        announcementRow({
          title: '维护公告更新',
          cta_label: null,
          cta_href: null,
          starts_at: null,
        }),
      ],
    ]);

    await expect(
      updateAnnouncement('announcement-1', {
        title: '维护公告更新',
        startsAt: null,
        ctaLabel: null,
        ctaHref: null,
      }),
    ).resolves.toMatchObject({
      title: '维护公告更新',
      cta_label: null,
      cta_href: null,
      starts_at: null,
    });

    expect(calls[1]?.params).toEqual([
      'announcement-1',
      '维护公告更新',
      '今晚维护',
      '今晚 23:00 维护',
      'published',
      10,
      null,
      null,
      null,
      null,
      '2026-06-12T00:00:00.000Z',
    ]);
  });

  it('blocks hard deletion for published announcements', async () => {
    createMockPool([[announcementRow({ status: 'published' })]]);

    await expect(deleteDraftAnnouncement('announcement-1')).resolves.toEqual({
      deleted: false,
      blockedStatus: 'published',
    });
  });
});
