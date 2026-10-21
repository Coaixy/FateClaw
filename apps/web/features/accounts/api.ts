import type { AccountSoulDto } from '@fateclaw/contracts/account';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import { requestJson } from '@/lib/http/client';

export type AccountSoul = AccountSoulDto;

export const accountsApi = {
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
