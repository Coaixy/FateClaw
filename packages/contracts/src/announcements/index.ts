export type AnnouncementStatus = 'draft' | 'published' | 'archived';

export interface AnnouncementPollWriteDto {
  question: string;
  allow_multiple: boolean;
  options: { id: string; label: string }[];
  closes_at: string | null;
  is_closed: boolean;
}

export interface AnnouncementPollDto extends AnnouncementPollWriteDto {
  options: { id: string; label: string; vote_count: number }[];
  total_votes: number;
  selected_option_ids: string[];
}

export interface AnnouncementDto {
  id: string;
  title: string;
  body_markdown: string;
  revision: number;
  published_at: string;
  poll?: AnnouncementPollDto | null;
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
  poll?: AnnouncementPollDto | null;
}

export interface AnnouncementWriteDto {
  title: string;
  body_markdown: string;
  status: AnnouncementStatus;
  expected_revision: number;
  poll?: AnnouncementPollWriteDto | null;
}

export interface AdminAnnouncementListDto {
  items: AdminAnnouncementDto[];
  total: number;
  page: number;
  page_size: number;
}
