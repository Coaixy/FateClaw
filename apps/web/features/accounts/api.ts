import type {
  AccountDto,
  AccountSoulDto,
  QrCodeResultDto,
  QrCodeStatusResultDto,
} from '@fateclaw/contracts/account';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import { createAuthScopedInFlightCache } from '@/lib/auth-scoped-cache';
import { requestJson } from '@/lib/http/client';

export type Account = AccountDto;
export type AccountSoul = AccountSoulDto;
export type QrCodeResult = QrCodeResultDto;
export type QrCodeStatusResult = QrCodeStatusResultDto;

const accountListRequestCache = createAuthScopedInFlightCache<Account[]>();

/**
 * 清理账号列表的 in-flight 请求缓存。
 *
 * @returns 无返回值。
 */
export function clearAccountsCache() {
  accountListRequestCache.clear();
}

export const accountsApi = {
  list: () =>
    accountListRequestCache.get(() => requestJson<Account[]>('/api/account')),
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
  getUserSoul: () => requestJson<AccountSoul>('/api/account/me/soul'),
  updateUserSoul: (content: string) =>
    requestJson<SuccessResponse>('/api/account/me/soul', {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),
  getQrCode: () =>
    requestJson<QrCodeResult>('/api/account/qrcode', { method: 'POST' }),
  pollQrStatus: (qrcode: string) =>
    requestJson<QrCodeStatusResult>('/api/account/qrcode/status', {
      method: 'POST',
      body: JSON.stringify({ qrcode }),
    }),
};
