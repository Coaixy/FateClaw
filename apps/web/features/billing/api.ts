import type {
  BillingStatusDto,
  CreateRechargeOrderResponseDto,
  DailyUsageRowDto,
  DailySignInResultDto,
  DailySignInStatusDto,
  MembershipSubscribeResultDto,
  PublicStatusOverviewDto,
  RechargeOrderDto,
  RechargePayTypeDto,
  RechargeStatsDto,
  UsageStatsDto,
  WalletTransactionDto,
} from '@fateclaw/contracts/billing';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import { createAuthScopedInFlightCache } from '@/lib/auth-scoped-cache';
import { requestJson } from '@/lib/http/client';

export type BillingStatus = BillingStatusDto;
export type MembershipSubscribeResult = MembershipSubscribeResultDto;
export type WalletTransaction = WalletTransactionDto;
export type UsageStats = UsageStatsDto;
export type DailyUsageRow = DailyUsageRowDto;
export type DailySignInStatus = DailySignInStatusDto;
export type DailySignInResult = DailySignInResultDto;
export type PublicStatusOverview = PublicStatusOverviewDto;
export type RechargePayType = RechargePayTypeDto;
export type RechargeOrder = RechargeOrderDto;
export type RechargeStats = RechargeStatsDto;

export interface BalanceGrant {
  id: string;
  user_id: string;
  source: string;
  granted_by: string | null;
  amount_coins: number;
  remaining_coins: number;
  note: string | null;
  expires_at: string | null;
  status: 'active' | 'exhausted' | 'expired' | 'revoked';
  created_at: string;
  updated_at: string;
}

const billingStatusRequestCache = createAuthScopedInFlightCache<BillingStatus>();
const usageRequestCache = createAuthScopedInFlightCache<UsageStats>();

/**
 * 清理账单概览和用量的 in-flight 请求缓存。
 *
 * @returns 无返回值。
 */
export function clearBillingCache() {
  billingStatusRequestCache.clear();
  usageRequestCache.clear();
}

export const billingApi = {
  status: () =>
    billingStatusRequestCache.get(() =>
      requestJson<BillingStatus>('/api/billing'),
    ),
  usage: () =>
    usageRequestCache.get(() =>
      requestJson<UsageStats>('/api/billing/usage'),
    ),
  dailyUsage: () =>
    requestJson<DailyUsageRow[]>('/api/billing/usage/daily'),
  publicStatus: () =>
    requestJson<PublicStatusOverview>('/api/billing/status'),
  transactions: () =>
    requestJson<WalletTransaction[]>('/api/billing/transactions'),
  dailySignInStatus: () =>
    requestJson<DailySignInStatus>('/api/billing/daily-sign-in'),
  claimDailySignIn: () =>
    requestJson<DailySignInResult>('/api/billing/daily-sign-in', {
      method: 'POST',
    }).finally(clearBillingCache),
  subscribeMembership: (data?: { plan_key?: string }) =>
    requestJson<MembershipSubscribeResult>('/api/billing/membership/subscribe', {
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    }).finally(clearBillingCache),
  rechargeOrders: () =>
    requestJson<RechargeOrder[]>('/api/billing/recharge/orders'),
  rechargeStats: () =>
    requestJson<RechargeStats>('/api/billing/recharge/stats'),
  createRechargeOrder: (data: {
    amount_coins: string | number;
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
  reset: (scope?: 'all' | 'messages' | 'memories') =>
    requestJson<SuccessResponse>('/api/billing/reset', {
      method: 'POST',
      body: JSON.stringify({ scope: scope || 'all' }),
    }).finally(clearBillingCache),
};
