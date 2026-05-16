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

export interface DailyUsageRowDto {
  date: string;
  msg_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface WalletTransactionDto {
  id: string;
  user_id: string;
  kind: string;
  amount_points: number;
  reserved_delta_points: number;
  point_source: 'purchased' | 'bonus' | 'earned' | 'mixed' | null;
  point_batch_id: string | null;
  request_id: string | null;
  note: string | null;
  metadata: unknown;
  created_at: string;
}

export interface BillingStatusDto {
  monthly_tokens_used: number;
  estimated_monthly_total_points: number;
  purchased_points: number;
  bonus_points: number;
  earned_points: number;
  reserved_points: number;
  available_points: number;
  pending_withdrawal_points: number;
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
  amount_points: number;
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
  total_recharge_points: number;
  total_recharge_yuan: string;
  last_paid_at: string | null;
}
