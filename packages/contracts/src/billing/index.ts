import type { MembershipPlanKey } from '../membership/index.js';

/**
 * 计费域跨端契约。
 */

export interface UsageStatsDto {
  total_messages: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  monthly_messages: number;
  today_messages: number;
  today_input_tokens: number;
  today_output_tokens: number;
  today_total_tokens: number;
}

export interface PublicStatusTokenUsagePointDto {
  date: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

/** 管理后台完整运行状态统计。 */
export interface AdminStatusStatsDto {
  today_messages: number;
  registered_users: number;
  today_total_tokens: number;
  processing_sessions: number;
  token_usage_series: PublicStatusTokenUsagePointDto[];
}

export interface DailyUsageRowDto {
  date: string;
  msg_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  official_model_charge_coins: number;
}

export interface WalletTransactionDto {
  id: string;
  user_id: string;
  kind: string;
  amount_coins: number;
  reserved_delta_coins: number;
  balance_source: 'purchased' | 'bonus' | 'mixed' | null;
  balance_grant_id: string | null;
  request_id: string | null;
  note: string | null;
  metadata: unknown;
  created_at: string;
}

export interface BillingStatusDto {
  monthly_tokens_used: number;
  monthly_charged_coins: number;
  purchased_coins: number;
  bonus_coins: number;
  reserved_coins: number;
  available_coins: number;
  membership: MembershipStatusDto;
  membership_entitlements: MembershipEntitlementDto[];
  membership_plans: MembershipPlanDto[];
}

/** 会员权益时间轴片段，按实际生效顺序返回给前端展示。 */
export interface MembershipEntitlementDto {
  plan_key: MembershipPlanKey;
  name: string;
  effective_start: string;
  effective_end: string;
  is_current: boolean;
}

export interface MembershipStatusDto {
  enabled: boolean;
  active: boolean;
  plan_key: MembershipPlanKey | null;
  monthly_price_coins: number;
  display_price_coins: number;
  current_period_start: string | null;
  current_period_end: string | null;
}

export interface MembershipPlanDto {
  plan_key: MembershipPlanKey;
  name: string;
  enabled: boolean;
  monthly_price_coins: number;
  display_price_coins: number;
  updated_at: string;
}

export interface MembershipSubscribeResultDto {
  membership: MembershipStatusDto;
  purchased_coins: number;
  bonus_coins: number;
  reserved_coins: number;
  available_coins: number;
}

export type RechargePayTypeDto = 'alipay' | 'wechat';
export type RechargeOrderStatusDto = 'pending' | 'paid' | 'failed';

export interface RechargeOrderDto {
  id: string;
  user_id: string;
  trade_id: string;
  provider: string;
  provider_trade_id: string | null;
  pay_type: RechargePayTypeDto;
  amount_coins: number;
  pay_url: string | null;
  status: RechargeOrderStatusDto;
  paid_at: string | null;
  notified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateRechargeOrderResponseDto {
  order: RechargeOrderDto;
  pay_url: string;
}

export interface RechargeStatsDto {
  total_paid_orders: number;
  total_recharge_coins: number;
  last_paid_at: string | null;
}
