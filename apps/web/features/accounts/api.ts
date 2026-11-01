import type { AccountSoulDto } from '@fateclaw/contracts/account';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import { requestJson } from '@/lib/http/client';

export type AccountSoul = AccountSoulDto;
export type SoulSaveResult = SuccessResponse & { sha256: string };

export const accountsApi = {
  getUserSoul: (signal?: AbortSignal) =>
    requestJson<AccountSoul>('/api/account/me/soul', {
      signal,
      timeoutMs: 15_000,
    }),
  updateUserSoul: (content: string, baseHash: string, signal?: AbortSignal) =>
    requestJson<SoulSaveResult>('/api/account/me/soul', {
      method: 'PUT',
      signal,
      timeoutMs: 15_000,
      body: JSON.stringify({
        content,
        base_hash: baseHash,
      }),
    }),
  updateUserSoulEditEnabled: (editEnabled: boolean, signal?: AbortSignal) =>
    requestJson<SuccessResponse>('/api/account/me/soul/edit-enabled', {
      method: 'PUT',
      signal,
      timeoutMs: 15_000,
      body: JSON.stringify({ edit_enabled: editEnabled }),
    }),
};
