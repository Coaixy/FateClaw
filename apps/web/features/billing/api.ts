import type {
  BillingStatusDto,
  CreateRechargeOrderResponseDto,
  DailyUsageRowDto,
  MembershipSubscribeResultDto,
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
export const BILLING_CHANGED_EVENT = 'fateclaw:billing-changed';

/**
 * 清理账单概览和用量的 in-flight 请求缓存。
 *
 * @returns 无返回值。
 */
export function clearBillingCache() {
  billingStatusRequestCache.clear();
  usageRequestCache.clear();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(BILLING_CHANGED_EVENT));
  }
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
  transactions: () =>
    requestJson<WalletTransaction[]>('/api/billing/transactions'),
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
  /**
   * 兑换卡密：把 redemption code 转成积分入账。
   *
   * 后端 POST /api/billing/redeem，成功返回入账面额与新余额拆解；
   * 失败（已兑换/已过期/已撤销等）返回 400 + { error }，被 requestJson
   * 归一化为 ApiError(message)，调用方可直接读 err.message 展示。
   * 成功后清 billing 缓存，让余额卡片即时反映扣加减后的额度。
   *
   * @param data.code 卡密码，1-50 字符。
   * @returns 入账面额 amountCoins 与最新 bonus/purchased 余额。
   */
  redeemCode: (data: { code: string }) =>
    requestJson<{ success: true; amountCoins: number; user: { bonus_coins: number; purchased_coins: number } }>(
      '/api/billing/redeem',
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    ).finally(clearBillingCache),
};
