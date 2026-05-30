/**
 * 计费域跨端契约。
 */

export interface UsageStatsDto {
  total_messages: number;
  total_input_tokens: number;
  total_output_tokens: number;
  today_messages: number;
  today_input_tokens: number;
  today_output_tokens: number;
}

export interface PublicStatusTokenUsagePointDto {
  date: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface PublicStatusStatsDto {
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
  official_model_charge_cents: number;
}

export interface WalletTransactionDto {
  id: string;
  user_id: string;
  kind: string;
  amount_cents: number;
  reserved_delta_cents: number;
  balance_source: 'purchased' | 'bonus' | 'mixed' | null;
  balance_grant_id: string | null;
  request_id: string | null;
  note: string | null;
  metadata: unknown;
  created_at: string;
}

export interface BillingStatusDto {
  monthly_tokens_used: number;
  estimated_monthly_total_cents: number;
  purchased_cents: number;
  bonus_cents: number;
  reserved_cents: number;
  available_cents: number;
}

export interface DailySignInStatusDto {
  enabled: boolean;
  reward_cents: number;
  sign_in_date: string;
  signed_in_today: boolean;
  signed_in_at: string | null;
}

export interface DailySignInResultDto extends DailySignInStatusDto {
  received_cents: number;
  bonus_cents: number;
  available_cents: number;
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
  amount_yuan: string;
  amount_cents: number;
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
  total_recharge_cents: number;
  total_recharge_yuan: string;
  last_paid_at: string | null;
}
