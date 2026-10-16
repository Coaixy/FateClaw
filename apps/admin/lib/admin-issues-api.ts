import type {
  AdminIssueDetailDto,
  AdminIssueListDto,
  IssueModerationDto,
} from '@fateclaw/contracts';
import { adminRequest } from './admin-api';

async function request<T>(path: string, options: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await adminRequest<T>(`/api/admin/issues${path}`, {
      ...options,
      cache: 'no-store',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
export const adminIssues = {
  list: (params: URLSearchParams) => request<AdminIssueListDto>(`?${params}`),
  detail: (id: number, before = 0) =>
    request<AdminIssueDetailDto>(`/${id}?before=${before}`),
  update: (id: number, body: IssueModerationDto) =>
    request<{ success: true }>(`/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  reply: (id: number, body: string, request_key: string) =>
    request<{ id: number }>(`/${id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body, request_key }),
    }),
  hideComment: (id: number, entry: number, hidden: boolean) =>
    request<{ success: true }>(`/${id}/comments/${entry}`, {
      method: 'PATCH',
      body: JSON.stringify({ hidden }),
    }),
  mute: (id: number, participant: number, muted: boolean) =>
    request<{ success: true }>(`/${id}/participants/${participant}`, {
      method: 'PATCH',
      body: JSON.stringify({ muted }),
    }),
};
