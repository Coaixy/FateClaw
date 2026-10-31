import type {
  AdminAnnouncementDto,
  AdminAnnouncementListDto,
  AnnouncementDto,
  AnnouncementStatus,
  AnnouncementWriteDto,
} from '@fateclaw/contracts';
import {
  getAnnouncementRow,
  getAnnouncementPolls,
  listAnnouncementRows,
  listPublishedAnnouncements,
  writeAnnouncementRow,
  writeAnnouncementVote,
  sameAnnouncementPoll,
  type AnnouncementRow,
} from '#infrastructure/repositories/announcements-repository';

function adminDto(row: AnnouncementRow): AdminAnnouncementDto {
  return {
    id: row.id,
    title: row.title,
    body_markdown: row.body_markdown,
    status: row.status,
    revision: row.revision,
    published_at: row.published_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function publicDto(row: AnnouncementRow): AnnouncementDto {
  return {
    id: row.id,
    title: row.title,
    body_markdown: row.body_markdown,
    revision: row.revision,
    published_at: row.published_at!.toISOString(),
  };
}

export async function getPublicAnnouncements(
  userId?: string,
): Promise<AnnouncementDto[]> {
  const rows = await listPublishedAnnouncements();
  const polls = await getAnnouncementPolls(
    rows.map((row) => row.id),
    userId,
  );
  return rows.map((row) => ({
    ...publicDto(row),
    poll: polls.get(row.id) ?? null,
  }));
}

export const castAnnouncementVote = writeAnnouncementVote;

export async function getAdminAnnouncements(
  page: number,
  status?: AnnouncementStatus,
): Promise<AdminAnnouncementListDto> {
  const { rows, total } = await listAnnouncementRows(page, status);
  const polls = await getAnnouncementPolls(rows.map((row) => row.id));
  return {
    items: rows.map((row) => ({
      ...adminDto(row),
      poll: polls.get(row.id) ?? null,
    })),
    total,
    page,
    page_size: 20,
  };
}

export async function saveAnnouncement(
  id: string,
  input: AnnouncementWriteDto,
): Promise<
  { announcement: AdminAnnouncementDto } | { error: string; status: 404 | 409 }
> {
  const row = await writeAnnouncementRow(id, input);
  if (row) {
    const polls = await getAnnouncementPolls([id]);
    return { announcement: { ...adminDto(row), poll: polls.get(id) ?? null } };
  }
  const existing = await getAnnouncementRow(id);
  const poll = existing
    ? ((await getAnnouncementPolls([id])).get(id) ?? null)
    : null;
  // A timed-out PUT may have committed. Replaying the same write must not republish it.
  if (
    existing &&
    existing.revision === input.expected_revision + 1 &&
    existing.title === input.title &&
    existing.body_markdown === input.body_markdown &&
    existing.status === input.status &&
    (input.poll === undefined || sameAnnouncementPoll(poll, input.poll))
  ) {
    return { announcement: { ...adminDto(existing), poll } };
  }
  return existing
    ? { error: '公告已被其他操作修改，请刷新列表后重新编辑', status: 409 }
    : { error: '公告不存在', status: 404 };
}
