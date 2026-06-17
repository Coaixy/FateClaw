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

/** 公开状态页服务级别。 */
export type PublicStatusLevelDto = 'operational' | 'degraded' | 'maintenance';

/** 公开状态页展示的服务标识。 */
export type PublicStatusServiceKeyDto =
  | 'ai_chat'
  | 'wallet'
  | 'membership'
  | 'wechat_binding';

/** 公开状态页服务状态。 */
export interface PublicStatusServiceDto {
  key: PublicStatusServiceKeyDto;
  status: PublicStatusLevelDto;
}

/** 公开状态页轻量概览，不包含业务规模和消耗指标。 */
export interface PublicStatusOverviewDto {
  updated_at: string;
  overall_status: PublicStatusLevelDto;
  services: PublicStatusServiceDto[];
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
  /** @deprecated 使用 monthly_charged_coins。兼容期内两者值保持一致。 */
  estimated_monthly_total_coins: number;
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
  plan_key: string;
  name: string;
  effective_start: string;
  effective_end: string;
  is_current: boolean;
}

export interface MembershipStatusDto {
  enabled: boolean;
  active: boolean;
  plan_key: string | null;
  monthly_price_coins: number;
  display_price_coins: number;
  current_period_start: string | null;
  current_period_end: string | null;
  allowance_reset_at: string | null;
  allowance_used_ratio: number;
  allowance_status:
    | 'inactive'
    | 'plenty'
    | 'normal'
    | 'tight'
    | 'almost_used'
    | 'used_up';
}

export interface MembershipPlanDto {
  plan_key: string;
  name: string;
  enabled: boolean;
  monthly_price_coins: number;
  display_price_coins: number;
  monthly_allowance_units: number;
  standard_price_per_million_units_coins: number;
  updated_at: string;
}

export interface MembershipSubscribeResultDto {
  membership: MembershipStatusDto;
  purchased_coins: number;
  bonus_coins: number;
  reserved_coins: number;
  available_coins: number;
}

export interface DailySignInStatusDto {
  enabled: boolean;
  reward_coins: number;
  sign_in_date: string;
  signed_in_today: boolean;
  signed_in_at: string | null;
}

export interface DailySignInResultDto extends DailySignInStatusDto {
  received_coins: number;
  purchased_coins: number;
  bonus_coins: number;
  reserved_coins: number;
  available_coins: number;
}

export type GiftCodeBalanceTypeDto = 'purchased' | 'bonus';
export type GiftCodeUsageTypeDto = 'single' | 'multi';
export type GiftCodeStatusDto = 'active' | 'disabled' | 'expired' | 'exhausted';

export interface GiftCodeDto {
  id: string;
  code: string;
  name: string;
  balance_type: GiftCodeBalanceTypeDto;
  usage_type: GiftCodeUsageTypeDto;
  amount_coins: number;
  max_redemptions: number;
  redeemed_count: number;
  enabled: boolean;
  expires_at: string | null;
  created_by: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  status: GiftCodeStatusDto;
}

export interface GiftCodeRedemptionDto {
  id: string;
  gift_code_id: string;
  user_id: string;
  wallet_transaction_id: string | null;
  balance_grant_id: string | null;
  balance_type: GiftCodeBalanceTypeDto;
  amount_coins: number;
  redeemed_at: string;
}

export interface GiftCodeRedeemResultDto {
  gift_code: GiftCodeDto;
  redemption: GiftCodeRedemptionDto;
  purchased_coins: number;
  bonus_coins: number;
  reserved_coins: number;
  available_coins: number;
}

export interface AdminGiftCodesResponseDto {
  gift_codes: GiftCodeDto[];
  total: number;
}

export interface AdminCreateGiftCodesResponseDto {
  gift_codes: GiftCodeDto[];
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
