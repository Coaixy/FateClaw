import type { AnnouncementDto, AnnouncementPollDto } from '@fateclaw/contracts';
import { requestJson } from '@/lib/http/client';

export const announcementsApi = {
  list: (signal?: AbortSignal) =>
    requestJson<{ items: AnnouncementDto[] }>('/api/announcements', {
      signal,
      timeoutMs: 10_000,
    }),
  vote: (
    id: string,
    optionIds: string[],
    revision: number,
    signal?: AbortSignal,
  ) =>
    requestJson<AnnouncementPollDto>(`/api/announcements/${id}/vote`, {
      method: 'PUT',
      body: JSON.stringify({
        option_ids: optionIds,
        expected_revision: revision,
      }),
      signal,
      timeoutMs: 10_000,
    }),
};
