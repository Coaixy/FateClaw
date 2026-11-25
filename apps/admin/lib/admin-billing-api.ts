import { adminRequest } from './admin-http';
import type {
  AdminRechargeOrderStatus,
  AdminRechargePayType,
  AdminRechargeOrdersResponse,
  AdminBillingHoldState,
  AdminBillingChargeState,
  AdminBillingReservationsResponse,
  AdminBillingReconcileResult,
  AdminWalletTransactionsResponse,
  AdminMembershipPlanConfig,
  AdminMembershipConfigResponse,
  AdminMembershipConfigUpdate,
  AdminRechargePaymentConfig,
  AdminRechargePaymentConfigUpdate,
} from './admin-api';
import type { MembershipPlanKey } from '@fateclaw/contracts/membership';

export const adminBillingApi = {
  rechargeOrders: (opts?: {
    user_id?: string;
    status?: AdminRechargeOrderStatus;
    pay_type?: AdminRechargePayType;
    limit?: number;
    offset?: number;
  }) => {
    const params = new URLSearchParams();
    if (opts?.user_id) params.set('user_id', opts.user_id);
    if (opts?.status) params.set('status', opts.status);
    if (opts?.pay_type) params.set('pay_type', opts.pay_type);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    const query = params.toString();
    return adminRequest<AdminRechargeOrdersResponse>(
      `/api/admin/billing/recharge-orders${query ? `?${query}` : ''}`,
    );
  },
  walletTransactions: (opts?: {
    user_id?: string;
    kind?: string;
    limit?: number;
    offset?: number;
  }) => {
    const params = new URLSearchParams();
    if (opts?.user_id) params.set('user_id', opts.user_id);
    if (opts?.kind) params.set('kind', opts.kind);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    const query = params.toString();
    return adminRequest<AdminWalletTransactionsResponse>(
      `/api/admin/billing/wallet-transactions${query ? `?${query}` : ''}`,
    );
  },
  billingReservations: (opts?: {
    user_id?: string;
    hold_state?: AdminBillingHoldState;
    charge_state?: AdminBillingChargeState;
    limit?: number;
    offset?: number;
  }) => {
    const params = new URLSearchParams();
    params.set('include_total', 'true');
    if (opts?.user_id) params.set('user_id', opts.user_id);
    if (opts?.hold_state) params.set('hold_state', opts.hold_state);
    if (opts?.charge_state) params.set('charge_state', opts.charge_state);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    const query = params.toString();
    return adminRequest<AdminBillingReservationsResponse>(
      `/api/admin/billing/reservations${query ? `?${query}` : ''}`,
    );
  },
  reconcileBillingReservations: (data?: {
    stale_ms?: number;
    limit?: number;
  }) =>
    adminRequest<AdminBillingReconcileResult>('/api/admin/billing/reconcile', {
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    }),
  rechargeConfig: () =>
    adminRequest<AdminRechargePaymentConfig>('/api/admin/recharge-config'),
  updateRechargeConfig: (data: AdminRechargePaymentConfigUpdate) =>
    adminRequest<AdminRechargePaymentConfig>('/api/admin/recharge-config', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  /** 读取全部会员套餐配置（含已停用，后台改价用）。 */
  membershipConfig: () =>
    adminRequest<AdminMembershipConfigResponse>('/api/admin/membership-config'),
  /** Updates the membership configuration. */
  updateMembershipConfig: (
    planKey: MembershipPlanKey,
    data: AdminMembershipConfigUpdate,
  ) =>
    adminRequest<AdminMembershipPlanConfig>(
      `/api/admin/membership-config/${encodeURIComponent(planKey)}`,
      { method: 'PATCH', body: JSON.stringify(data) },
    ),
};
