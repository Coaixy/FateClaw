import type {
  AdminAnnouncementDto,
  AdminAnnouncementListDto,
  AnnouncementDto,
  AnnouncementStatus,
  AnnouncementWriteDto,
} from '@fateclaw/contracts';
import {
  getAnnouncementRow,
  listAnnouncementRows,
  listPublishedAnnouncements,
  writeAnnouncementRow,
  type AnnouncementRow,
} from '../../infrastructure/repositories/announcements-repository.js';

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

export async function getPublicAnnouncements(): Promise<AnnouncementDto[]> {
  return (await listPublishedAnnouncements()).map((row) => ({
    id: row.id,
    title: row.title,
    body_markdown: row.body_markdown,
    revision: row.revision,
    published_at: row.published_at!.toISOString(),
  }));
}

export async function getAdminAnnouncements(
  page: number,
  status?: AnnouncementStatus,
): Promise<AdminAnnouncementListDto> {
  const { rows, total } = await listAnnouncementRows(page, status);
  return { items: rows.map(adminDto), total, page, page_size: 20 };
}

export async function saveAnnouncement(
  id: string,
  input: AnnouncementWriteDto,
): Promise<
  { announcement: AdminAnnouncementDto } | { error: string; status: 404 | 409 }
> {
  const row = await writeAnnouncementRow(id, input);
  if (row) return { announcement: adminDto(row) };
  const existing = await getAnnouncementRow(id);
  // A timed-out PUT may have committed. Replaying the same write must not republish it.
  if (
    existing &&
    existing.revision === input.expected_revision + 1 &&
    existing.title === input.title &&
    existing.body_markdown === input.body_markdown &&
    existing.status === input.status
  ) {
    return { announcement: adminDto(existing) };
  }
  return existing
    ? { error: '公告已被其他操作修改，请刷新列表后重新编辑', status: 409 }
    : { error: '公告不存在', status: 404 };
}
