import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const database = vi.hoisted(() => ({ pool: undefined as pg.Pool | undefined }));
vi.mock('../../../src/infrastructure/db-pool.js', () => ({
  getDbPool: () => database.pool!,
}));

import { popupAnnouncementsMigration } from '../../../src/infrastructure/migrations/versions/0091-popup-announcements.js';
import {
  getAdminAnnouncements,
  getPublicAnnouncements,
  saveAnnouncement,
} from '../../../src/modules/announcements/announcement-service.js';

const connectionString = process.env.FATECLAW_TEST_MIGRATIONS_DATABASE_URL;

describe.skipIf(!connectionString)('popup announcements on PostgreSQL', () => {
  let admin: pg.Pool;
  const name = `fateclaw_announcements_test_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(connectionString!);
    url.pathname = `/${name}`;
    database.pool = new pg.Pool({
      connectionString: url.toString(),
      connectionTimeoutMillis: 5000,
    });
    const client = await database.pool.connect();
    try {
      await popupAnnouncementsMigration.up(client);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await database.pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await database.pool!.query('TRUNCATE popup_announcements');
  });

  const draft = {
    title: '维护通知',
    body_markdown: '**维护安排**',
    status: 'draft' as const,
    expected_revision: 0,
  };

  it('publishes drafts, updates the visible version, and removes archived notices', async () => {
    const id = randomUUID();
    await saveAnnouncement(id, draft);
    expect(await getPublicAnnouncements()).toEqual([]);
    expect((await getAdminAnnouncements(1, 'draft')).items).toHaveLength(1);

    await saveAnnouncement(id, {
      ...draft,
      status: 'published',
      expected_revision: 1,
    });
    const [published] = await getPublicAnnouncements();
    expect(published).toMatchObject({ id, title: draft.title, revision: 2 });
    expect(published.published_at).toBeTruthy();
    expect(published).not.toHaveProperty('status');

    await saveAnnouncement(id, {
      ...draft,
      title: '维护时间已更新',
      status: 'published',
      expected_revision: 2,
    });
    expect(await getPublicAnnouncements()).toMatchObject([
      { title: '维护时间已更新', revision: 3 },
    ]);
    await saveAnnouncement(id, {
      ...draft,
      status: 'archived',
      expected_revision: 3,
    });
    expect(await getPublicAnnouncements()).toEqual([]);
    expect((await getAdminAnnouncements(1, 'archived')).total).toBe(1);
  });

  it('replays timed-out writes without incrementing the revision or publication time', async () => {
    const id = randomUUID();
    const input = { ...draft, status: 'published' as const };
    const first = await saveAnnouncement(id, input);
    expect(await saveAnnouncement(id, input)).toEqual(first);
    const update = { ...input, title: '更新通知', expected_revision: 1 };
    const second = await saveAnnouncement(id, update);
    expect(await saveAnnouncement(id, update)).toEqual(second);
    expect((await getAdminAnnouncements(1)).total).toBe(1);
  });

  it('allows one concurrent editor to win and rejects stale or missing edits', async () => {
    const id = randomUUID();
    await saveAnnouncement(id, draft);
    const results = await Promise.all([
      saveAnnouncement(id, { ...draft, title: '编辑 A', expected_revision: 1 }),
      saveAnnouncement(id, { ...draft, title: '编辑 B', expected_revision: 1 }),
    ]);
    expect(results.filter((result) => 'announcement' in result)).toHaveLength(
      1,
    );
    expect(
      results.filter((result) => 'status' in result && result.status === 409),
    ).toHaveLength(1);
    expect(
      await saveAnnouncement(randomUUID(), { ...draft, expected_revision: 1 }),
    ).toMatchObject({ status: 404 });
  });

  it('returns the latest 20 published notices and paginates the administrative history', async () => {
    await database.pool!.query(`
      INSERT INTO popup_announcements(id, title, body_markdown, status, published_at)
      SELECT md5(i::text)::uuid, 'Notice ' || i, 'Body', 'published',
        '2026-10-01'::timestamptz + i * interval '1 hour'
      FROM generate_series(1, 25) AS i
    `);
    const items = await getPublicAnnouncements();
    expect(items).toHaveLength(20);
    expect(items[0].title).toBe('Notice 25');
    expect(items.at(-1)?.title).toBe('Notice 6');
    expect(await getAdminAnnouncements(2)).toMatchObject({
      total: 25,
      page: 2,
      page_size: 20,
    });
    expect((await getAdminAnnouncements(2)).items).toHaveLength(5);
  });
});
