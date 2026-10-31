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
vi.mock('#infrastructure/db-pool', () => ({
  getDbPool: () => database.pool!,
}));

import { popupAnnouncementsMigration } from '#infrastructure/migrations/versions/0091-popup-announcements';
import { announcementPollsMigration } from '#infrastructure/migrations/versions/0100-announcement-polls';
import { announcementMultipleChoiceMigration } from '#infrastructure/migrations/versions/0101-announcement-multiple-choice';
import { AnnouncementError } from '#modules/announcements/announcement-error';
import {
  getAdminAnnouncements,
  getPublicAnnouncements,
  saveAnnouncement,
  castAnnouncementVote,
} from '#modules/announcements/announcement-service';

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
      await client.query('CREATE TABLE users (id text PRIMARY KEY)');
      await popupAnnouncementsMigration.up(client);
      await announcementPollsMigration.up(client);
      await announcementMultipleChoiceMigration.up(client);
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
    await database.pool!.query('TRUNCATE popup_announcements, users CASCADE');
    await database.pool!.query(
      "INSERT INTO users VALUES ('voter-a'), ('voter-b')",
    );
  });

  const draft = {
    title: '维护通知',
    body_markdown: '**维护安排**',
    status: 'draft' as const,
    expected_revision: 0,
  };

  function pollInput() {
    return {
      question: '下次优先更新什么？',
      allow_multiple: false,
      options: [
        { id: randomUUID(), label: '移动端体验' },
        { id: randomUUID(), label: '排盘功能' },
      ],
      closes_at: null as string | null,
      is_closed: false,
    };
  }

  async function publishPoll(allowMultiple = false) {
    const id = randomUUID();
    const input = { ...draft, status: 'published' as const, poll: pollInput() };
    input.poll.allow_multiple = allowMultiple;
    await saveAnnouncement(id, input);
    return { id, input };
  }

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

  it('keeps one vote per account through retries, changes and concurrent submissions', async () => {
    const { id, input } = await publishPoll();
    const [a, b] = input.poll.options;
    const first = await castAnnouncementVote(id, 'voter-a', [a.id], 1);
    expect(await castAnnouncementVote(id, 'voter-a', [a.id], 1)).toEqual(first);
    await Promise.all([
      castAnnouncementVote(id, 'voter-a', [a.id], 1),
      castAnnouncementVote(id, 'voter-a', [b.id], 1),
      castAnnouncementVote(id, 'voter-b', [a.id], 1),
    ]);
    await castAnnouncementVote(id, 'voter-a', [b.id], 1);
    const [anonymous] = await getPublicAnnouncements();
    const [viewer] = await getPublicAnnouncements('voter-a');
    expect(anonymous.revision).toBe(1);
    expect(anonymous.poll).toMatchObject({
      total_votes: 2,
      selected_option_ids: [],
    });
    expect(viewer.poll).toMatchObject({
      total_votes: 2,
      selected_option_ids: [b.id],
      options: [
        { id: a.id, vote_count: 1 },
        { id: b.id, vote_count: 1 },
      ],
    });
    expect((await getAdminAnnouncements(1)).items[0].poll).toMatchObject({
      total_votes: 2,
      selected_option_ids: [],
    });
  });

  it('rejects another poll option and votes on drafts or archived notices', async () => {
    const { id, input } = await publishPoll();
    const other = await publishPoll();
    await expect(
      castAnnouncementVote(id, 'voter-a', [other.input.poll.options[0].id], 1),
    ).rejects.toMatchObject({ statusCode: 400 });
    for (const status of ['draft', 'archived'] as const) {
      const result = await saveAnnouncement(id, {
        ...input,
        status,
        expected_revision: status === 'draft' ? 1 : 2,
      });
      expect(result).toHaveProperty('announcement');
      await expect(
        castAnnouncementVote(id, 'voter-a', [input.poll.options[0].id], 3),
      ).rejects.toMatchObject({ statusCode: 404 });
    }
    expect(
      (await getAdminAnnouncements(1)).items.find((item) => item.id === id)
        ?.poll?.total_votes,
    ).toBe(0);
  });

  it.each(['manual', 'deadline'] as const)(
    'enforces %s closure while allowing a committed vote retry',
    async (kind) => {
      const { id, input } = await publishPoll();
      const [a, b] = input.poll.options;
      await castAnnouncementVote(id, 'voter-a', [a.id], 1);
      const poll = {
        ...input.poll,
        is_closed: kind === 'manual',
        closes_at: kind === 'deadline' ? '2000-01-01T00:00:00.000Z' : null,
      };
      await saveAnnouncement(id, { ...input, poll, expected_revision: 1 });
      await expect(
        castAnnouncementVote(id, 'voter-b', [b.id], 2),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        castAnnouncementVote(id, 'voter-a', [b.id], 2),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(
        await castAnnouncementVote(id, 'voter-a', [a.id], 1),
      ).toMatchObject({
        total_votes: 1,
        selected_option_ids: [a.id],
      });
    },
  );

  it('freezes voted questions and options and rolls back the entire invalid announcement edit', async () => {
    const { id, input } = await publishPoll();
    await castAnnouncementVote(id, 'voter-a', [input.poll.options[0].id], 1);
    for (const poll of [
      null,
      { ...input.poll, allow_multiple: true },
      { ...input.poll, question: '另一个问题' },
      {
        ...input.poll,
        options: input.poll.options.map((option) => ({
          ...option,
          label: `${option.label}改变`,
        })),
      },
    ]) {
      await expect(
        saveAnnouncement(id, {
          ...input,
          title: '应回滚',
          poll,
          expected_revision: 1,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    }
    expect((await getPublicAnnouncements())[0]).toMatchObject({
      title: draft.title,
      revision: 1,
      poll: { total_votes: 1 },
    });
    await saveAnnouncement(id, {
      ...input,
      title: '进展更新',
      expected_revision: 1,
    });
    expect((await getPublicAnnouncements('voter-a'))[0]).toMatchObject({
      title: '进展更新',
      revision: 2,
      poll: { total_votes: 1, selected_option_ids: [input.poll.options[0].id] },
    });
  });

  it('serializes the first vote against an option edit without changing the meaning of a stored vote', async () => {
    const { id, input } = await publishPoll();
    const changed = {
      ...input,
      expected_revision: 1,
      poll: {
        ...input.poll,
        options: input.poll.options.map((option) => ({
          ...option,
          label: `${option.label}新版`,
        })),
      },
    };
    const results = await Promise.allSettled([
      castAnnouncementVote(id, 'voter-a', [input.poll.options[0].id], 1),
      saveAnnouncement(id, changed),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AnnouncementError);
    expect(rejected.reason.statusCode).toBe(409);
    const [current] = await getPublicAnnouncements();
    if (current.poll!.total_votes) {
      expect(current.poll!.options[0].label).toBe(input.poll.options[0].label);
      expect(current.revision).toBe(1);
    } else {
      expect(current.poll!.options[0].label).toBe(
        changed.poll.options[0].label,
      );
      expect(current.revision).toBe(2);
    }
  });

  it('replays poll configuration writes exactly and preserves omitted poll data for existing callers', async () => {
    const { id, input } = await publishPoll();
    const replay = await saveAnnouncement(id, input);
    expect(replay).toMatchObject({
      announcement: { revision: 1, poll: { question: input.poll.question } },
    });
    expect(
      await saveAnnouncement(id, {
        ...input,
        poll: { ...input.poll, is_closed: true },
      }),
    ).toMatchObject({ status: 409 });
    await saveAnnouncement(id, {
      ...draft,
      status: 'published',
      expected_revision: 1,
    });
    expect((await getPublicAnnouncements())[0].poll?.question).toBe(
      input.poll.question,
    );
    await expect(
      castAnnouncementVote(id, 'voter-a', [input.poll.options[0].id], 1),
    ).rejects.toMatchObject({ statusCode: 409 });
    await saveAnnouncement(id, { ...input, poll: null, expected_revision: 2 });
    expect((await getPublicAnnouncements())[0].poll).toBeNull();
  });

  it('counts multi-choice participants once and atomically replaces a complete selection', async () => {
    const { id, input } = await publishPoll(true);
    const [a, b] = input.poll.options;
    const first = await castAnnouncementVote(id, 'voter-a', [a.id, b.id], 1);
    expect(first).toMatchObject({
      allow_multiple: true,
      total_votes: 1,
      selected_option_ids: [a.id, b.id],
      options: [{ vote_count: 1 }, { vote_count: 1 }],
    });
    expect(await castAnnouncementVote(id, 'voter-a', [b.id, a.id], 1)).toEqual(
      first,
    );
    await castAnnouncementVote(id, 'voter-b', [a.id], 1);
    expect((await getPublicAnnouncements())[0].poll).toMatchObject({
      total_votes: 2,
      selected_option_ids: [],
      options: [{ vote_count: 2 }, { vote_count: 1 }],
    });
    expect(await castAnnouncementVote(id, 'voter-a', [b.id], 1)).toMatchObject({
      total_votes: 2,
      selected_option_ids: [b.id],
      options: [{ vote_count: 1 }, { vote_count: 1 }],
    });
    expect((await getAdminAnnouncements(1)).items[0].poll).toMatchObject({
      total_votes: 2,
      selected_option_ids: [],
    });
    expect(
      (await getPublicAnnouncements('voter-a'))[0].poll?.selected_option_ids,
    ).toEqual([b.id]);
    expect(
      (await getPublicAnnouncements('voter-b'))[0].poll?.selected_option_ids,
    ).toEqual([a.id]);
  });

  it('rejects multiple selections for single-choice polls and invalid sets without changing a prior ballot', async () => {
    for (const multiple of [false, true]) {
      const { id, input } = await publishPoll(multiple);
      const [a, b] = input.poll.options;
      const original = await castAnnouncementVote(id, 'voter-a', [a.id], 1);
      const invalid = [
        [],
        [a.id, a.id],
        [a.id, randomUUID()],
        ...(multiple ? [] : [[a.id, b.id]]),
      ];
      for (const selection of invalid) {
        await expect(
          castAnnouncementVote(id, 'voter-a', selection, 1),
        ).rejects.toMatchObject({ statusCode: 400 });
        expect(await castAnnouncementVote(id, 'voter-a', [a.id], 1)).toEqual(
          original,
        );
      }
    }
  });

  it.each(['manual', 'deadline'] as const)(
    'preserves the complete stored selection when %s closure rejects an edit',
    async (kind) => {
      const { id, input } = await publishPoll(true);
      const [a, b] = input.poll.options;
      await castAnnouncementVote(id, 'voter-a', [a.id, b.id], 1);
      await saveAnnouncement(id, {
        ...input,
        expected_revision: 1,
        poll: {
          ...input.poll,
          is_closed: kind === 'manual',
          closes_at: kind === 'deadline' ? '2000-01-01T00:00:00.000Z' : null,
        },
      });
      await expect(
        castAnnouncementVote(id, 'voter-a', [a.id], 2),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        castAnnouncementVote(id, 'voter-b', [a.id, b.id], 2),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(
        await castAnnouncementVote(id, 'voter-a', [b.id, a.id], 1),
      ).toMatchObject({
        total_votes: 1,
        selected_option_ids: [a.id, b.id],
        options: [{ vote_count: 1 }, { vote_count: 1 }],
      });
    },
  );

  it('serializes concurrent multi-choice ballots as full replacements rather than merging their options', async () => {
    const id = randomUUID();
    const poll = { ...pollInput(), allow_multiple: true };
    poll.options.push({ id: randomUUID(), label: '知识库' });
    await saveAnnouncement(id, { ...draft, status: 'published', poll });
    const [a, b, c] = poll.options;
    const ballots = [
      [a.id, b.id],
      [b.id, c.id],
    ];
    await Promise.all(
      ballots.map((ids) => castAnnouncementVote(id, 'voter-a', ids, 1)),
    );
    const [result] = await getPublicAnnouncements('voter-a');
    const selected = result.poll!.selected_option_ids;
    expect(
      ballots.some(
        (ids) =>
          ids.length === selected.length &&
          ids.every((id) => selected.includes(id)),
      ),
    ).toBe(true);
    expect(result.poll!.total_votes).toBe(1);
    expect(
      result
        .poll!.options.map((option) => option.vote_count)
        .reduce((sum, count) => sum + count, 0),
    ).toBe(2);
    expect(
      (
        await database.pool!.query(
          'SELECT count(*)::integer AS total FROM announcement_poll_votes WHERE announcement_id = $1',
          [id],
        )
      ).rows[0].total,
    ).toBe(2);
  });

  it('locks the mode once a multi-choice vote commits and detects mode changes in retried admin writes', async () => {
    const { id, input } = await publishPoll(true);
    expect(await saveAnnouncement(id, input)).toMatchObject({
      announcement: { revision: 1, poll: { allow_multiple: true } },
    });
    expect(
      await saveAnnouncement(id, {
        ...input,
        poll: { ...input.poll, allow_multiple: false },
      }),
    ).toMatchObject({ status: 409 });
    await castAnnouncementVote(
      id,
      'voter-a',
      input.poll.options.map((option) => option.id),
      1,
    );
    await expect(
      saveAnnouncement(id, {
        ...input,
        expected_revision: 1,
        poll: { ...input.poll, allow_multiple: false },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await getPublicAnnouncements())[0]).toMatchObject({
      revision: 1,
      poll: { allow_multiple: true, total_votes: 1 },
    });
  });
});
