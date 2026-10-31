import type {
  IssueCreateDto,
  IssueDetailDto,
  IssueUnreadSummaryDto,
  IssueUpdateDto,
  PublicIssueListDto,
} from '@fateclaw/contracts';
import { requestJson } from '@/lib/http/client';

const request = <T>(path: string, options: RequestInit = {}) =>
  requestJson<T>(path, { ...options, timeoutMs: 15_000 });
export const issuesApi = {
  list: (params: URLSearchParams, signal?: AbortSignal) =>
    request<PublicIssueListDto>(`/api/issues?${params}`, { signal }),
  unreadCount: () => request<IssueUnreadSummaryDto>('/api/issues/unread-count'),
  detail: (id: number, before = 0, signal?: AbortSignal) =>
    request<IssueDetailDto>(`/api/issues/${id}?before=${before}`, { signal }),
  create: (body: IssueCreateDto) =>
    request<{ id: number }>('/api/issues', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  update: (id: number, body: IssueUpdateDto) =>
    request<{ success: true }>(`/api/issues/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  comment: (id: number, body: string, request_key: string) =>
    request<{ id: number }>(`/api/issues/${id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body, request_key }),
    }),
  editComment: (id: number, entry: number, body: string) =>
    request<{ success: true }>(`/api/issues/${id}/comments/${entry}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    }),
};
