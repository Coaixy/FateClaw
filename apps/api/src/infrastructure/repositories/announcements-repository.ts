import type {
  AnnouncementPollDto,
  AnnouncementPollWriteDto,
  AnnouncementStatus,
  AnnouncementWriteDto,
} from '@fateclaw/contracts';
import { getDbPool, type DbQueryable } from '#infrastructure/db-pool';
import { queryOne, queryRows } from '#infrastructure/typed-query';
import { AnnouncementError } from '#modules/announcements/announcement-error';

export interface AnnouncementRow {
  id: string;
  title: string;
  body_markdown: string;
  status: AnnouncementStatus;
  revision: number;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function listPublishedAnnouncements(): Promise<AnnouncementRow[]> {
  return queryRows<AnnouncementRow>(
    getDbPool(),
    `SELECT * FROM popup_announcements WHERE status = 'published'
     ORDER BY published_at DESC, id LIMIT 20`,
  );
}

export async function listAnnouncementRows(
  page: number,
  status?: AnnouncementStatus,
): Promise<{ rows: AnnouncementRow[]; total: number }> {
  const pool = getDbPool();
  const rows = await queryRows<AnnouncementRow>(
    pool,
    `SELECT * FROM popup_announcements WHERE ($1::text IS NULL OR status = $1)
     ORDER BY updated_at DESC, id LIMIT 20 OFFSET $2`,
    [status ?? null, (page - 1) * 20],
  );
  const count = await queryOne<{ total: string }>(
    pool,
    `SELECT count(*) AS total FROM popup_announcements
     WHERE ($1::text IS NULL OR status = $1)`,
    [status ?? null],
  );
  return { rows, total: Number(count?.total ?? 0) };
}

export async function getAnnouncementRow(id: string) {
  return queryOne<AnnouncementRow>(
    getDbPool(),
    'SELECT * FROM popup_announcements WHERE id = $1',
    [id],
  );
}

export async function getAnnouncementPolls(
  ids: string[],
  userId?: string,
  db: DbQueryable = getDbPool(),
): Promise<Map<string, AnnouncementPollDto>> {
  const polls = new Map<string, AnnouncementPollDto>();
  if (!ids.length) return polls;
  const rows = await queryRows<{
    announcement_id: string;
    question: string;
    allow_multiple: boolean;
    closes_at: Date | null;
    is_closed: boolean;
    option_id: string;
    label: string;
    vote_count: number;
    total_votes: number;
    selected: boolean | null;
  }>(
    db,
    `WITH participation AS (
       SELECT announcement_id, count(DISTINCT user_id)::integer AS total_votes
       FROM announcement_poll_votes WHERE announcement_id = ANY($1::uuid[])
       GROUP BY announcement_id
     )
     SELECT p.*, o.id AS option_id, o.label, o.position,
       COALESCE(participation.total_votes, 0) AS total_votes,
       count(v.user_id)::integer AS vote_count,
       bool_or(v.user_id = $2::text) AS selected
     FROM announcement_polls p
     JOIN announcement_poll_options o ON o.announcement_id = p.announcement_id
     LEFT JOIN announcement_poll_votes v
       ON v.announcement_id = o.announcement_id AND v.option_id = o.id
     LEFT JOIN participation ON participation.announcement_id = p.announcement_id
     WHERE p.announcement_id = ANY($1::uuid[])
     GROUP BY p.announcement_id, o.announcement_id, o.id, participation.total_votes
     ORDER BY p.announcement_id, o.position`,
    [ids, userId ?? null],
  );
  for (const row of rows) {
    let poll = polls.get(row.announcement_id);
    if (!poll) {
      poll = {
        question: row.question,
        allow_multiple: row.allow_multiple,
        closes_at: row.closes_at?.toISOString() ?? null,
        is_closed: row.is_closed,
        options: [],
        total_votes: row.total_votes,
        selected_option_ids: [],
      };
      polls.set(row.announcement_id, poll);
    }
    poll.options.push({
      id: row.option_id,
      label: row.label,
      vote_count: row.vote_count,
    });
    if (row.selected) poll.selected_option_ids.push(row.option_id);
  }
  return polls;
}

export function sameAnnouncementPoll(
  current: AnnouncementPollDto | null,
  input: AnnouncementPollWriteDto | null,
): boolean {
  return (
    samePollOptions(current, input) &&
    current?.is_closed === input?.is_closed &&
    (current?.closes_at ?? null) ===
      (input?.closes_at ? new Date(input.closes_at).toISOString() : null)
  );
}

function samePollOptions(
  current: AnnouncementPollWriteDto | null,
  input: AnnouncementPollWriteDto | null,
): boolean {
  if (!current || !input) return current === input;
  return (
    current.question === input.question &&
    current.allow_multiple === input.allow_multiple &&
    current.options.length === input.options.length &&
    current.options.every(
      (option, index) =>
        option.id === input.options[index].id &&
        option.label === input.options[index].label,
    )
  );
}

async function writePoll(
  db: DbQueryable,
  id: string,
  input: AnnouncementPollWriteDto | null,
) {
  const current =
    (await getAnnouncementPolls([id], undefined, db)).get(id) ?? null;
  const unchangedOptions = samePollOptions(current, input);
  if (current?.total_votes && !unchangedOptions) {
    throw new AnnouncementError(
      409,
      '已有用户投票，不能修改投票模式、问题、选项或移除投票；请新建公告发起新投票',
    );
  }
  if (!input) {
    await db.query(
      'DELETE FROM announcement_polls WHERE announcement_id = $1',
      [id],
    );
    return;
  }
  await db.query(
    `INSERT INTO announcement_polls(announcement_id, question, closes_at, is_closed, allow_multiple)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (announcement_id) DO UPDATE SET
       question = EXCLUDED.question, closes_at = EXCLUDED.closes_at,
       is_closed = EXCLUDED.is_closed, allow_multiple = EXCLUDED.allow_multiple`,
    [
      id,
      input.question,
      input.closes_at,
      input.is_closed,
      input.allow_multiple,
    ],
  );
  if (unchangedOptions) return;
  await db.query(
    'DELETE FROM announcement_poll_options WHERE announcement_id = $1',
    [id],
  );
  await db.query(
    `INSERT INTO announcement_poll_options(announcement_id, id, label, position)
     SELECT $1, (item.value->>'id')::uuid, item.value->>'label', (item.position - 1)::smallint
     FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS item(value, position)`,
    [id, JSON.stringify(input.options)],
  );
}

export async function writeAnnouncementRow(
  id: string,
  input: AnnouncementWriteDto,
): Promise<AnnouncementRow | undefined> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const values = [id, input.title, input.body_markdown, input.status];
    let row: AnnouncementRow | undefined;
    if (input.expected_revision === 0) {
      row = await queryOne<AnnouncementRow>(
        client,
        `INSERT INTO popup_announcements (id, title, body_markdown, status, published_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'published' THEN clock_timestamp() END)
         ON CONFLICT (id) DO NOTHING RETURNING *`,
        values,
      );
    } else {
      // Configuration changes and votes share this lock so option edits cannot erase a racing vote.
      const existing = await queryOne<AnnouncementRow>(
        client,
        'SELECT * FROM popup_announcements WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (existing?.revision === input.expected_revision) {
        row = await queryOne<AnnouncementRow>(
          client,
          `UPDATE popup_announcements SET title = $2, body_markdown = $3, status = $4,
             revision = revision + 1, updated_at = clock_timestamp(),
             published_at = CASE WHEN $4 = 'published' THEN clock_timestamp() ELSE published_at END
           WHERE id = $1 AND revision = $5 RETURNING *`,
          [...values, input.expected_revision],
        );
      }
    }
    if (row && input.poll !== undefined)
      await writePoll(client, id, input.poll);
    await client.query('COMMIT');
    return row;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function writeAnnouncementVote(
  id: string,
  userId: string,
  optionIds: string[],
  expectedRevision: number,
): Promise<AnnouncementPollDto> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const announcement = await queryOne<AnnouncementRow>(
      client,
      'SELECT * FROM popup_announcements WHERE id = $1 FOR UPDATE',
      [id],
    );
    const poll = (await getAnnouncementPolls([id], userId, client)).get(id);
    if (announcement?.status !== 'published' || !poll) {
      throw new AnnouncementError(404, '公告投票不存在或已下线');
    }
    if (
      !optionIds.length ||
      optionIds.length > poll.options.length ||
      new Set(optionIds).size !== optionIds.length ||
      !optionIds.every((id) => poll.options.some((option) => option.id === id))
    ) {
      throw new AnnouncementError(400, '请选择当前投票中的有效选项');
    }
    if (!poll.allow_multiple && optionIds.length !== 1) {
      throw new AnnouncementError(400, '当前投票为单选，只能选择一项');
    }
    const unchanged =
      poll.selected_option_ids.length === optionIds.length &&
      optionIds.every((id) => poll.selected_option_ids.includes(id));
    if (!unchanged) {
      if (announcement.revision !== expectedRevision) {
        throw new AnnouncementError(409, '公告已更新，请刷新后重新投票');
      }
      // Replacing the whole ballot keeps retries and concurrent edits from accumulating selections.
      await client.query(
        'DELETE FROM announcement_poll_votes WHERE announcement_id = $1 AND user_id = $2',
        [id, userId],
      );
      const votes = await queryRows<{ option_id: string }>(
        client,
        `INSERT INTO announcement_poll_votes(announcement_id, user_id, option_id)
         SELECT p.announcement_id, $2, option.id FROM announcement_polls p
         CROSS JOIN unnest($3::uuid[]) AS option(id)
         WHERE p.announcement_id = $1 AND NOT p.is_closed
           AND (p.closes_at IS NULL OR p.closes_at > clock_timestamp())
         RETURNING option_id`,
        [id, userId, optionIds],
      );
      if (votes.length !== optionIds.length)
        throw new AnnouncementError(409, '投票已结束，无法提交或修改');
    }
    const result = (await getAnnouncementPolls([id], userId, client)).get(id)!;
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
