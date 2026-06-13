import { randomUUID } from 'node:crypto';

import { getDbPool } from '../db-pool.js';

const ANNOUNCEMENT_COLUMNS = `
  id,
  slug,
  title,
  summary,
  body_markdown,
  status,
  priority,
  starts_at,
  ends_at,
  cta_label,
  cta_href,
  published_at,
  created_at,
  updated_at
`;

/** 公告发布状态。 */
export type AnnouncementStatus = 'draft' | 'published' | 'archived';

/** 公告数据库行。 */
export interface AnnouncementRow {
  id: string;
  slug: string;
  title: string;
  summary: string;
  body_markdown: string;
  status: AnnouncementStatus;
  priority: number;
  starts_at: string | null;
  ends_at: string | null;
  cta_label: string | null;
  cta_href: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 创建公告时允许写入的字段。 */
export interface AnnouncementCreateInput {
  title: string;
  summary: string;
  bodyMarkdown: string;
  status: AnnouncementStatus;
  priority: number;
  startsAt: string | null;
  endsAt: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
}

/** 更新公告时允许写入的字段。 */
export type AnnouncementUpdateInput = Partial<AnnouncementCreateInput>;

function createAnnouncementSlug(): string {
  return `announcement-${randomUUID()}`;
}

function toInt(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function normalizeAnnouncementRow(row: AnnouncementRow): AnnouncementRow {
  return {
    ...row,
    priority: toInt(row.priority),
    starts_at: row.starts_at ?? null,
    ends_at: row.ends_at ?? null,
    cta_label: row.cta_label ?? null,
    cta_href: row.cta_href ?? null,
    published_at: row.published_at ?? null,
  };
}

function isPublishTransition(
  currentStatus: AnnouncementStatus,
  nextStatus: AnnouncementStatus,
  currentPublishedAt: string | null,
): boolean {
  return (
    nextStatus === 'published' &&
    (currentStatus !== 'published' || !currentPublishedAt)
  );
}

function isProvided<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/**
 * 列出后台可管理的全部公告。
 *
 * @returns 按更新时间倒序排列的公告列表。
 */
export async function listAdminAnnouncements(): Promise<AnnouncementRow[]> {
  const { rows } = await getDbPool().query<AnnouncementRow>(
    `SELECT ${ANNOUNCEMENT_COLUMNS}
     FROM announcements
     ORDER BY updated_at DESC, created_at DESC`,
  );
  return rows.map(normalizeAnnouncementRow);
}

/**
 * 列出公开公告。
 *
 * @returns 已发布且已到开始时间的公告，包含已结束公告作为历史留档。
 */
export async function listPublicAnnouncements(): Promise<AnnouncementRow[]> {
  const { rows } = await getDbPool().query<AnnouncementRow>(
    `SELECT ${ANNOUNCEMENT_COLUMNS}
     FROM announcements
     WHERE status = 'published'
       AND (starts_at IS NULL OR starts_at <= NOW())
     ORDER BY published_at DESC NULLS LAST, updated_at DESC`,
  );
  return rows.map(normalizeAnnouncementRow);
}

/**
 * 读取当前应显示在横幅上的公告。
 *
 * @returns 当前有效公告；没有符合条件的公告时返回 null。
 */
export async function getActiveAnnouncement(): Promise<AnnouncementRow | null> {
  const { rows } = await getDbPool().query<AnnouncementRow>(
    `SELECT ${ANNOUNCEMENT_COLUMNS}
     FROM announcements
     WHERE status = 'published'
       AND (starts_at IS NULL OR starts_at <= NOW())
       AND (ends_at IS NULL OR ends_at > NOW())
     ORDER BY priority DESC, published_at DESC NULLS LAST, updated_at DESC
     LIMIT 1`,
  );
  return rows[0] ? normalizeAnnouncementRow(rows[0]) : null;
}

/**
 * 通过 slug 读取公开公告详情。
 *
 * @param slug 公开详情页路径标识。
 * @returns 已发布且已到开始时间的公告；不存在或未公开时返回 null。
 */
export async function getPublicAnnouncementBySlug(
  slug: string,
): Promise<AnnouncementRow | null> {
  const { rows } = await getDbPool().query<AnnouncementRow>(
    `SELECT ${ANNOUNCEMENT_COLUMNS}
     FROM announcements
     WHERE slug = $1
       AND status = 'published'
       AND (starts_at IS NULL OR starts_at <= NOW())
     LIMIT 1`,
    [slug],
  );
  return rows[0] ? normalizeAnnouncementRow(rows[0]) : null;
}

/**
 * 通过 ID 读取后台公告。
 *
 * @param id 公告 ID。
 * @returns 找到时返回公告，否则返回 null。
 */
export async function getAdminAnnouncementById(
  id: string,
): Promise<AnnouncementRow | null> {
  const { rows } = await getDbPool().query<AnnouncementRow>(
    `SELECT ${ANNOUNCEMENT_COLUMNS}
     FROM announcements
     WHERE id = $1
     LIMIT 1`,
    [id],
  );
  return rows[0] ? normalizeAnnouncementRow(rows[0]) : null;
}

/**
 * 创建公告。
 *
 * @param input 创建公告所需字段。
 * @returns 新创建的公告行。
 */
export async function createAnnouncement(
  input: AnnouncementCreateInput,
): Promise<AnnouncementRow> {
  const slug = createAnnouncementSlug();
  const publishedAt =
    input.status === 'published' ? new Date().toISOString() : null;
  const { rows } = await getDbPool().query<AnnouncementRow>(
    `INSERT INTO announcements (
       id, slug, title, summary, body_markdown, status, priority,
       starts_at, ends_at, cta_label, cta_href, published_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${ANNOUNCEMENT_COLUMNS}`,
    [
      `announcement-${randomUUID()}`,
      slug,
      input.title,
      input.summary,
      input.bodyMarkdown,
      input.status,
      input.priority,
      input.startsAt,
      input.endsAt,
      input.ctaLabel,
      input.ctaHref,
      publishedAt,
    ],
  );
  return normalizeAnnouncementRow(rows[0]!);
}

/**
 * 更新公告。
 *
 * @param id 公告 ID。
 * @param input 可更新字段；未传入字段保持原值。
 * @returns 更新后的公告；不存在时返回 null。
 */
export async function updateAnnouncement(
  id: string,
  input: AnnouncementUpdateInput,
): Promise<AnnouncementRow | null> {
  const current = await getAdminAnnouncementById(id);
  if (!current) return null;

  const nextStatus = input.status ?? current.status;
  const nextPublishedAt = isPublishTransition(
    current.status,
    nextStatus,
    current.published_at,
  )
    ? new Date().toISOString()
    : current.published_at;

  const { rows } = await getDbPool().query<AnnouncementRow>(
    `UPDATE announcements
     SET title = $2,
         summary = $3,
         body_markdown = $4,
         status = $5,
         priority = $6,
         starts_at = $7,
         ends_at = $8,
         cta_label = $9,
         cta_href = $10,
         published_at = $11,
         updated_at = NOW()
     WHERE id = $1
     RETURNING ${ANNOUNCEMENT_COLUMNS}`,
    [
      id,
      isProvided(input.title) ? input.title : current.title,
      isProvided(input.summary) ? input.summary : current.summary,
      isProvided(input.bodyMarkdown)
        ? input.bodyMarkdown
        : current.body_markdown,
      nextStatus,
      isProvided(input.priority) ? input.priority : current.priority,
      isProvided(input.startsAt) ? input.startsAt : current.starts_at,
      isProvided(input.endsAt) ? input.endsAt : current.ends_at,
      isProvided(input.ctaLabel) ? input.ctaLabel : current.cta_label,
      isProvided(input.ctaHref) ? input.ctaHref : current.cta_href,
      nextPublishedAt,
    ],
  );
  return rows[0] ? normalizeAnnouncementRow(rows[0]) : null;
}

/**
 * 删除草稿公告。
 *
 * @param id 公告 ID。
 * @returns `deleted` 表示是否删除；`blockedStatus` 表示因非草稿状态被拒绝。
 */
export async function deleteDraftAnnouncement(id: string): Promise<{
  deleted: boolean;
  blockedStatus: AnnouncementStatus | null;
}> {
  const current = await getAdminAnnouncementById(id);
  if (!current) {
    return { deleted: false, blockedStatus: null };
  }
  if (current.status !== 'draft') {
    return { deleted: false, blockedStatus: current.status };
  }

  const { rowCount } = await getDbPool().query(
    `DELETE FROM announcements WHERE id = $1 AND status = 'draft'`,
    [id],
  );
  return { deleted: (rowCount ?? 0) > 0, blockedStatus: null };
}
