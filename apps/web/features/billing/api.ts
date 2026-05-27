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

export const billingApi = {
  status: () => requestJson<BillingStatus>('/api/billing'),
  usage: () => requestJson<UsageStats>('/api/billing/usage'),
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
    ),
  syncRechargeOrder: (tradeId: string) =>
    requestJson<RechargeOrder>(
      `/api/billing/recharge/orders/${encodeURIComponent(tradeId)}/sync`,
      { method: 'POST' },
    ),
  reset: (scope?: 'all' | 'messages' | 'memories' | 'tasks' | 'skills') =>
    requestJson<SuccessResponse>('/api/billing/reset', {
      method: 'POST',
      body: JSON.stringify({ scope: scope || 'all' }),
    }),
};
