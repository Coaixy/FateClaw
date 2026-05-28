import type {
  AccountDto,
  AccountSoulDto,
  QrCodeResultDto,
  QrCodeStatusResultDto,
} from '@fateclaw/contracts/account';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import { requestJson } from '@/lib/http/client';

export type Account = AccountDto;
export type AccountSoul = AccountSoulDto;
export type QrCodeResult = QrCodeResultDto;
export type QrCodeStatusResult = QrCodeStatusResultDto;

let accountListRequest: Promise<Account[]> | null = null;

export function clearAccountsCache() {
  accountListRequest = null;
}

export const accountsApi = {
  list: () => {
    accountListRequest ??= requestJson<Account[]>('/api/account').finally(
      () => {
        accountListRequest = null;
      },
    );
    return accountListRequest;
  },
  get: (id: string) =>
    requestJson<Account>(`/api/account/${encodeURIComponent(id)}`),
  bind: (id: string) =>
    requestJson<SuccessResponse>(
      `/api/account/${encodeURIComponent(id)}/bind`,
      {
        method: 'POST',
      },
    ),
  remove: (id: string) =>
    requestJson<SuccessResponse>(
      `/api/account/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
      },
    ).finally(clearAccountsCache),
  getSoul: (id: string) =>
    requestJson<AccountSoul>(`/api/account/${encodeURIComponent(id)}/soul`),
  updateSoul: (id: string, content: string) =>
    requestJson<SuccessResponse>(
      `/api/account/${encodeURIComponent(id)}/soul`,
      {
        method: 'PUT',
        body: JSON.stringify({ content }),
      },
    ),
  getQrCode: () =>
    requestJson<QrCodeResult>('/api/account/qrcode', { method: 'POST' }),
  pollQrStatus: (qrcode: string) =>
    requestJson<QrCodeStatusResult>('/api/account/qrcode/status', {
      method: 'POST',
      body: JSON.stringify({ qrcode }),
    }),
};
