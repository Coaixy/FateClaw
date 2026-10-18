import type {
  AnnouncementStatus,
  AnnouncementWriteDto,
} from '@fateclaw/contracts';
import { getDbPool } from '#infrastructure/db-pool';
import { queryOne, queryRows } from '#infrastructure/typed-query';

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

export async function writeAnnouncementRow(
  id: string,
  input: AnnouncementWriteDto,
): Promise<AnnouncementRow | undefined> {
  const values = [id, input.title, input.body_markdown, input.status];
  if (input.expected_revision === 0) {
    return queryOne<AnnouncementRow>(
      getDbPool(),
      `INSERT INTO popup_announcements (id, title, body_markdown, status, published_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'published' THEN clock_timestamp() END)
       ON CONFLICT (id) DO NOTHING RETURNING *`,
      values,
    );
  }
  // The revision check owns both content changes and publication in one atomic write.
  return queryOne<AnnouncementRow>(
    getDbPool(),
    `UPDATE popup_announcements SET title = $2, body_markdown = $3, status = $4,
       revision = revision + 1, updated_at = clock_timestamp(),
       published_at = CASE WHEN $4 = 'published' THEN clock_timestamp() ELSE published_at END
     WHERE id = $1 AND revision = $5 RETURNING *`,
    [...values, input.expected_revision],
  );
}
