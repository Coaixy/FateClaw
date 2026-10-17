import type {
  CompletedRechargeRefundDto,
  CompletedRechargeRefundRequestDto,
  CreatedRegistrationInviteDto,
  CreateRegistrationInviteRequestDto,
  RegistrationInviteAccountUpdateDto,
  RegistrationInviteDto,
  RegistrationInvitePolicyDto,
  RegistrationInvitePolicyUpdateDto,
  RegistrationInviteSummaryDto,
} from '@fateclaw/contracts/auth';
import { adminRequest } from './admin-api';

async function request<T>(path: string, options: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await adminRequest<T>(`/api/admin/registration-invites${path}`, {
      ...options,
      cache: 'no-store',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function userQuery(userId?: string) {
  return userId ? `?${new URLSearchParams({ user_id: userId })}` : '';
}

export const adminRegistrationInvites = {
  policy: () => request<RegistrationInvitePolicyDto>('/policy'),
  updatePolicy: (body: RegistrationInvitePolicyUpdateDto) =>
    request<RegistrationInvitePolicyDto>('/policy', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  user: (userId: string) =>
    request<RegistrationInviteSummaryDto>(
      `/users/${encodeURIComponent(userId)}`,
    ),
  updateUser: (userId: string, body: RegistrationInviteAccountUpdateDto) =>
    request<RegistrationInviteSummaryDto>(
      `/users/${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
      },
    ),
  list: (userId?: string) =>
    request<{ items: RegistrationInviteDto[] }>(userQuery(userId)),
  create: (body: CreateRegistrationInviteRequestDto) =>
    request<CreatedRegistrationInviteDto>('', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  revoke: (id: string) =>
    request<{ success: true }>(`/${encodeURIComponent(id)}/revoke`, {
      method: 'POST',
    }),
  refunds: (userId?: string) =>
    request<{ items: CompletedRechargeRefundDto[] }>(
      `/refunds${userQuery(userId)}`,
    ),
  recordCompletedRefund: (body: CompletedRechargeRefundRequestDto) =>
    request<CompletedRechargeRefundDto>('/refunds', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
