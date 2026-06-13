import { requestJson } from '@/lib/http/client';

/** 公开公告状态。 */
export type PublicAnnouncementStatus = 'draft' | 'published' | 'archived';

/** 公开公告 DTO。 */
export interface PublicAnnouncement {
  id: string;
  slug: string;
  title: string;
  summary: string;
  body_markdown: string;
  status: PublicAnnouncementStatus;
  priority: number;
  starts_at: string | null;
  ends_at: string | null;
  cta_label: string | null;
  cta_href: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 当前横幅公告响应。 */
export interface ActiveAnnouncementResponse {
  announcement: PublicAnnouncement | null;
}

/** 公开公告列表响应。 */
export interface PublicAnnouncementsResponse {
  announcements: PublicAnnouncement[];
}

/** 公开公告详情响应。 */
export interface PublicAnnouncementDetailResponse {
  announcement: PublicAnnouncement;
}

/** 公开公告 API 客户端。 */
export const announcementsApi = {
  active: () =>
    requestJson<ActiveAnnouncementResponse>('/api/public/announcements/active'),
  list: () =>
    requestJson<PublicAnnouncementsResponse>('/api/public/announcements'),
  detail: (slug: string) =>
    requestJson<PublicAnnouncementDetailResponse>(
      `/api/public/announcements/${encodeURIComponent(slug)}`,
    ),
};
