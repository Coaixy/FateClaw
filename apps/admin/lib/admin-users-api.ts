import { adminRequest } from './admin-http';
import type {
  AdminUser,
  AdminUsersPageResult,
  WalletTransaction,
  AdminBalanceGrant,
  UserDetail,
  AdminMembershipState,
} from './admin-api';
import type { MembershipPlanKey } from '@fateclaw/contracts/membership';

export const adminUsersApi = {
  users: (params?: { page?: number; page_size?: number; q?: string }) => {
    const search = new URLSearchParams();
    if (params?.page != null) search.set('page', String(params.page));
    if (params?.page_size != null)
      search.set('page_size', String(params.page_size));
    if (params?.q?.trim()) search.set('q', params.q.trim());
    const query = search.toString();
    return adminRequest<AdminUsersPageResult>(
      `/api/admin/users${query ? `?${query}` : ''}`,
    );
  },
  createUser: (data: {
    phone: string;
    password: string;
    role: AdminUser['role'];
    phone_verified: boolean;
  }) =>
    adminRequest<{ success: boolean; id: string }>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  userDetail: (id: string) =>
    adminRequest<UserDetail>(`/api/admin/users/${encodeURIComponent(id)}`),
  resetUserPassword: (id: string, password: string) =>
    adminRequest<{ id: string; auth_token_version: number }>(
      `/api/admin/users/${encodeURIComponent(id)}/password`,
      {
        method: 'POST',
        body: JSON.stringify({ password }),
      },
    ),
  setUserMembership: (
    id: string,
    data: { plan_key: MembershipPlanKey; current_period_end: string },
  ) =>
    adminRequest<AdminMembershipState>(
      `/api/admin/users/${encodeURIComponent(id)}/membership`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    ),
  cancelUserMembership: (id: string) =>
    adminRequest<AdminMembershipState>(
      `/api/admin/users/${encodeURIComponent(id)}/membership`,
      { method: 'DELETE' },
    ),
  adjustPurchasedBalance: (
    id: string,
    data: { amount_coins: number; note?: string },
  ) =>
    adminRequest<{
      success: boolean;
      purchased_coins: number;
      bonus_coins: number;
      reserved_coins: number;
      available_coins: number;
    }>(`/api/admin/users/${encodeURIComponent(id)}/balance/adjust`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  userTransactions: (id: string) =>
    adminRequest<WalletTransaction[]>(
      `/api/admin/users/${encodeURIComponent(id)}/transactions`,
    ),
  userBalanceGrants: (
    id: string,
    opts?: { include_exhausted?: boolean; limit?: number },
  ) => {
    const params = new URLSearchParams();
    params.set('limit', String(opts?.limit ?? 20));
    if (opts?.include_exhausted) params.set('include_exhausted', 'true');
    return adminRequest<AdminBalanceGrant[]>(
      `/api/admin/users/${encodeURIComponent(id)}/balance/grants?${params.toString()}`,
    );
  },
  deleteUser: (id: string) =>
    adminRequest<{ success: boolean }>(
      `/api/admin/users/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  grantBonusBalance: (
    id: string,
    data: {
      amount_coins: number;
      source?: 'new_user_gift' | 'sign_in' | 'admin_grant' | 'promotion';
      note?: string;
      expires_at?: string | null;
    },
  ) =>
    adminRequest<{
      success: boolean;
      grant_id: string;
      bonus_coins: number;
    }>(`/api/admin/users/${encodeURIComponent(id)}/balance/grant`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};
