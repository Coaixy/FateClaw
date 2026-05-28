import type {
  BillingStatusDto,
  CreateRechargeOrderResponseDto,
  DailyUsageRowDto,
  RechargeOrderDto,
  RechargePayTypeDto,
  RechargeStatsDto,
  UsageStatsDto,
  WalletTransactionDto,
} from '@fateclaw/contracts/billing';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import { requestJson } from '@/lib/http/client';

export type BillingStatus = BillingStatusDto;
export type WalletTransaction = WalletTransactionDto;
export type UsageStats = UsageStatsDto;
export type DailyUsageRow = DailyUsageRowDto;
export type RechargePayType = RechargePayTypeDto;
export type RechargeOrder = RechargeOrderDto;
export type RechargeStats = RechargeStatsDto;

export interface PointBatch {
  id: string;
  user_id: string;
  source: string;
  granted_by: string | null;
  amount_points: number;
  remaining_points: number;
  note: string | null;
  expires_at: string | null;
  status: 'active' | 'exhausted' | 'expired' | 'revoked';
  created_at: string;
  updated_at: string;
}

let billingStatusRequest: Promise<BillingStatus> | null = null;
let usageRequest: Promise<UsageStats> | null = null;

export function clearBillingCache() {
  billingStatusRequest = null;
  usageRequest = null;
}

export const billingApi = {
  status: () => {
    billingStatusRequest ??= requestJson<BillingStatus>('/api/billing').finally(
      () => {
        billingStatusRequest = null;
      },
    );
    return billingStatusRequest;
  },
  usage: () => {
    usageRequest ??= requestJson<UsageStats>('/api/billing/usage').finally(
      () => {
        usageRequest = null;
      },
    );
    return usageRequest;
  },
  dailyUsage: () =>
    requestJson<DailyUsageRow[]>('/api/billing/usage/daily'),
  transactions: () =>
    requestJson<WalletTransaction[]>('/api/billing/transactions'),
  rechargeOrders: () =>
    requestJson<RechargeOrder[]>('/api/billing/recharge/orders'),
  rechargeStats: () =>
    requestJson<RechargeStats>('/api/billing/recharge/stats'),
  createRechargeOrder: (data: {
    amount_yuan: string | number;
    pay_type: RechargePayType;
  }) =>
    requestJson<CreateRechargeOrderResponseDto>(
      '/api/billing/recharge/orders',
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    ).finally(clearBillingCache),
  syncRechargeOrder: (tradeId: string) =>
    requestJson<RechargeOrder>(
      `/api/billing/recharge/orders/${encodeURIComponent(tradeId)}/sync`,
      { method: 'POST' },
    ).finally(clearBillingCache),
  reset: (scope?: 'all' | 'messages' | 'memories' | 'tasks') =>
    requestJson<SuccessResponse>('/api/billing/reset', {
      method: 'POST',
      body: JSON.stringify({ scope: scope || 'all' }),
    }).finally(clearBillingCache),
};
