export type AnnouncementStatus = 'draft' | 'published' | 'archived';

export interface AnnouncementDto {
  id: string;
  title: string;
  body_markdown: string;
  revision: number;
  published_at: string;
}

export interface AdminAnnouncementDto {
  id: string;
  title: string;
  body_markdown: string;
  status: AnnouncementStatus;
  revision: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AnnouncementWriteDto {
  title: string;
  body_markdown: string;
  status: AnnouncementStatus;
  expected_revision: number;
}

export interface AdminAnnouncementListDto {
  items: AdminAnnouncementDto[];
  total: number;
  page: number;
  page_size: number;
}
