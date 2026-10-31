import type {
  AdminIssueDetailDto,
  AdminIssueListDto,
  AdminIssueSummaryDto,
  IssueDto,
  IssueDetailDto,
  IssueUnreadSummaryDto,
  PublicIssueListDto,
} from '@fateclaw/contracts';
import {
  countAwaitingReplyIssues,
  countUnreadIssues,
  getIssueRows,
  listIssueRows,
  type IssueListFilter,
  type IssueRow,
} from '#infrastructure/repositories/issues-repository';

function publicIssue(row: IssueRow, viewer?: string): IssueDto {
  // Public DTOs are allowlists: private attribution never reaches the public response.
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    state: row.state,
    close_reason: row.close_reason,
    labels: row.labels,
    locked: row.locked,
    author: {
      kind: 'user',
      participant_number: 0,
      is_self: row.author_user_id === viewer,
    },
    comment_count: row.comment_count ?? 0,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function listPublicIssues(
  filter: IssueListFilter,
  viewer?: string,
): Promise<PublicIssueListDto> {
  const { rows, total } = await listIssueRows(filter, false, viewer ?? null);
  return {
    items: rows.map((row) => publicIssue(row, viewer)),
    total,
    page: filter.page,
    page_size: filter.page_size,
    unread_ids: rows.filter((row) => row.unread).map((row) => row.id),
  };
}

export async function listAdminIssues(
  filter: IssueListFilter,
): Promise<AdminIssueListDto> {
  const { rows, total } = await listIssueRows(filter, true);
  return {
    items: rows.map((row) => publicIssue(row)),
    total,
    page: filter.page,
    page_size: filter.page_size,
    hidden_ids: rows.filter((row) => row.hidden).map((row) => row.id),
    awaiting_reply_ids: rows
      .filter((row) => row.awaiting_reply)
      .map((row) => row.id),
  };
}

export async function getIssueUnreadSummary(
  userId: string,
): Promise<IssueUnreadSummaryDto> {
  return { unread_count: await countUnreadIssues(userId) };
}

export async function getAdminIssueSummary(): Promise<AdminIssueSummaryDto> {
  return { awaiting_reply_count: await countAwaitingReplyIssues() };
}

function publicDetail(
  rows: Awaited<ReturnType<typeof getIssueRows>>,
  viewer?: string,
): IssueDetailDto {
  return {
    issue: publicIssue(rows.issue, viewer),
    body: rows.issue.body,
    entries: rows.entries.map((entry) => ({
      id: entry.id,
      type: entry.type,
      body: entry.body,
      close_reason: entry.close_reason,
      author: {
        kind: entry.actor_kind,
        participant_number: entry.participant_number,
        is_self: entry.actor_user_id === viewer,
      },
      created_at: entry.created_at.toISOString(),
      updated_at: entry.updated_at.toISOString(),
    })),
    next_cursor: rows.next_cursor,
  };
}

export async function getPublicIssue(
  id: number,
  after: number,
  viewer?: string,
): Promise<IssueDetailDto> {
  return publicDetail(await getIssueRows(id, after, false), viewer);
}

export async function getAdminIssue(
  id: number,
  after: number,
): Promise<AdminIssueDetailDto> {
  const rows = await getIssueRows(id, after, true);
  return {
    detail: publicDetail(rows),
    hidden: rows.issue.hidden,
    hidden_entry_ids: rows.entries
      .filter((entry) => entry.hidden)
      .map((entry) => entry.id),
    identities: rows.identities.map((identity) => ({
      participant_number: identity.participant_number,
      user_id: identity.user_id,
      phone: identity.phone,
      phone_verified: identity.phone_verified,
      account_created_at: identity.created_at.toISOString(),
      muted: identity.muted,
    })),
  };
}
