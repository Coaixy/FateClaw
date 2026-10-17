import type { AnnouncementDto } from '@fateclaw/contracts';
import { requestJson } from '@/lib/http/client';

export const announcementsApi = {
  list: (signal?: AbortSignal) =>
    requestJson<{ items: AnnouncementDto[] }>('/api/announcements', {
      signal,
      timeoutMs: 10_000,
    }),
};
