import type {
  AdminAnnouncementDto,
  AdminAnnouncementListDto,
  AnnouncementStatus,
  AnnouncementWriteDto,
} from '@fateclaw/contracts';
import { adminRequest } from './admin-api';

async function request<T>(path: string, options: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await adminRequest<T>(`/api/admin/announcements${path}`, {
      ...options,
      cache: 'no-store',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export const adminAnnouncements = {
  list: (page: number, status?: AnnouncementStatus) => {
    const params = new URLSearchParams({ page: String(page) });
    if (status) params.set('status', status);
    return request<AdminAnnouncementListDto>(`?${params}`);
  },
  save: (id: string, body: AnnouncementWriteDto) =>
    request<AdminAnnouncementDto>(`/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
};
