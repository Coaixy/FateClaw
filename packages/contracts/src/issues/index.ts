export const ISSUE_KINDS = ['bug', 'feature'] as const;
export const ISSUE_LABELS = [
  'needs_info',
  'confirmed',
  'planned',
  'in_progress',
] as const;
export const ISSUE_CLOSE_REASONS = [
  'resolved',
  'not_planned',
  'duplicate',
] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];
export type IssueLabel = (typeof ISSUE_LABELS)[number];
export type IssueCloseReason = (typeof ISSUE_CLOSE_REASONS)[number];
export type IssueState = 'open' | 'closed';

export interface IssueAuthorDto {
  kind: 'user' | 'official';
  participant_number: number | null;
  is_self: boolean;
}
export interface IssueDto {
  id: number;
  title: string;
  kind: IssueKind;
  state: IssueState;
  close_reason: IssueCloseReason | null;
  labels: IssueLabel[];
  locked: boolean;
  author: IssueAuthorDto;
  comment_count: number;
  created_at: string;
  updated_at: string;
}
export interface IssueListDto {
  items: IssueDto[];
  total: number;
  page: number;
  page_size: number;
}
export type IssueEntryType =
  | 'comment'
  | 'edited'
  | 'closed'
  | 'reopened'
  | 'labels_changed'
  | 'locked'
  | 'unlocked';
export interface IssueEntryDto {
  id: number;
  type: IssueEntryType;
  body: string | null;
  author: IssueAuthorDto;
  created_at: string;
  updated_at: string;
  close_reason: IssueCloseReason | null;
}
export interface IssueDetailDto {
  issue: IssueDto;
  body: string;
  entries: IssueEntryDto[];
  next_cursor: number | null;
}
export interface IssueCreateDto {
  title: string;
  body: string;
  kind: IssueKind;
  request_key: string;
}
export interface IssueCommentCreateDto {
  body: string;
  request_key: string;
}
export interface IssueUpdateDto {
  title: string;
  body: string;
}
export interface IssueModerationDto {
  state?: IssueState;
  close_reason?: IssueCloseReason | null;
  labels?: IssueLabel[];
  locked?: boolean;
  hidden?: boolean;
}
export interface IssueIdentityDto {
  participant_number: number;
  user_id: string;
  phone: string | null;
  phone_verified: boolean;
  account_created_at: string;
  muted: boolean;
}
export interface AdminIssueDetailDto {
  detail: IssueDetailDto;
  hidden: boolean;
  identities: IssueIdentityDto[];
  hidden_entry_ids: number[];
}
export interface AdminIssueListDto extends IssueListDto {
  hidden_ids: number[];
}
