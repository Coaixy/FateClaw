import type { AccountDto, AccountSoulDto } from '@fateclaw/contracts/account';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import { createAuthScopedInFlightCache } from '@/lib/auth-scoped-cache';
import { requestJson } from '@/lib/http/client';

export type Account = AccountDto;
export type AccountSoul = AccountSoulDto;

const accountListRequestCache = createAuthScopedInFlightCache<Account[]>();

export const accountsApi = {
  list: () =>
    accountListRequestCache.get(() => requestJson<Account[]>('/api/account')),
  getUserSoul: () => requestJson<AccountSoul>('/api/account/me/soul'),
  updateUserSoul: (content: string, editEnabled?: boolean) =>
    requestJson<SuccessResponse>('/api/account/me/soul', {
      method: 'PUT',
      body: JSON.stringify({
        content,
        ...(editEnabled === undefined ? {} : { edit_enabled: editEnabled }),
      }),
    }),
  updateUserSoulEditEnabled: (editEnabled: boolean) =>
    requestJson<SuccessResponse>('/api/account/me/soul/edit-enabled', {
      method: 'PUT',
      body: JSON.stringify({ edit_enabled: editEnabled }),
    }),
};
