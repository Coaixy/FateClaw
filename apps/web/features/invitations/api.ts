import type {
  CreatedRegistrationInviteDto,
  CreateRegistrationInviteRequestDto,
  RegistrationInvitePreviewDto,
  RegistrationInviteSummaryDto,
} from '@fateclaw/contracts/auth';

import { requestJson } from '@/lib/http/client';

export const registrationInvitesApi = {
  preview: (inviteCode: string) =>
    requestJson<RegistrationInvitePreviewDto>('/api/auth/invites/preview', {
      method: 'POST',
      cache: 'no-store',
      timeoutMs: 15_000,
      body: JSON.stringify({ inviteCode }),
    }),
  summary: () =>
    requestJson<RegistrationInviteSummaryDto>('/api/auth/invites/me', {
      cache: 'no-store',
      timeoutMs: 15_000,
    }),
  create: (requestKey: string) =>
    requestJson<CreatedRegistrationInviteDto>('/api/auth/invites', {
      method: 'POST',
      cache: 'no-store',
      timeoutMs: 15_000,
      body: JSON.stringify({
        request_key: requestKey,
      } satisfies CreateRegistrationInviteRequestDto),
    }),
  revoke: (id: string) =>
    requestJson<RegistrationInviteSummaryDto>(
      `/api/auth/invites/${encodeURIComponent(id)}/revoke`,
      { method: 'POST', cache: 'no-store', timeoutMs: 15_000 },
    ),
};
