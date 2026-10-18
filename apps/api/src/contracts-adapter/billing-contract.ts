import type {
  BillingStatusDto,
  DailyUsageRowDto,
  MembershipEntitlementDto,
  MembershipPlanDto,
  MembershipStatusDto,
  MembershipSubscribeResultDto,
  RechargeOrderDto,
  RechargeStatsDto,
  UsageStatsDto,
  WalletTransactionDto,
} from '@fateclaw/contracts/billing';

import type {
  MembershipEntitlementRow,
  RechargeOrderRow,
  RechargeStatsRow,
} from '../infrastructure/db.js';
import type {
  MembershipBillingSummary,
  MembershipPlanSummary,
  MonthlyMeteredBillingSummary,
  WalletBalanceSummary,
} from '../modules/billing/plans.js';

/** 统一的钱包余额 contract 字段，所有余额变动响应都应保持这四项。 */
export type WalletBalanceDto = Pick<
  BillingStatusDto,
  'purchased_coins' | 'bonus_coins' | 'reserved_coins' | 'available_coins'
>;

/**
 * 将内部钱包余额摘要转换为统一 contract 字段。
 *
 * @param wallet 内部 camelCase 钱包摘要。
 * @returns 充值、赠送、冻结、可消费余额四字段。
 */
export function toWalletBalanceDto(
  wallet: Pick<
    WalletBalanceSummary,
    'purchasedCoins' | 'bonusCoins' | 'reservedCoins' | 'availableCoins'
  >,
): WalletBalanceDto {
  return {
    purchased_coins: wallet.purchasedCoins,
    bonus_coins: wallet.bonusCoins,
    reserved_coins: wallet.reservedCoins,
    available_coins: wallet.availableCoins,
  };
}

/**
 * 将会员状态摘要转换为 contract DTO。
 *
 * @param membership 内部会员结算摘要。
 * @returns 对外会员状态 DTO。
 */
export function toMembershipStatusDto(
  membership: MembershipBillingSummary,
): MembershipStatusDto {
  return {
    enabled: membership.enabled,
    active: membership.active,
    plan_key: membership.planKey,
    monthly_price_coins: membership.monthlyPriceCoins,
    display_price_coins: membership.displayPriceCoins,
    current_period_start: membership.currentPeriodStart,
    current_period_end: membership.currentPeriodEnd,
  };
}

/**
 * 将会员权益时间轴行转换为 contract DTO。
 *
 * @param entitlement repository 返回的权益时间轴片段。
 * @returns 对外权益时间轴 DTO。
 */
export function toMembershipEntitlementDto(
  entitlement: MembershipEntitlementRow,
): MembershipEntitlementDto {
  return {
    plan_key: entitlement.plan_key,
    name: entitlement.name,
    effective_start: entitlement.effective_start,
    effective_end: entitlement.effective_end,
    is_current: entitlement.is_current,
  };
}

/**
 * 将会员套餐摘要转换为 contract DTO。
 *
 * @param plan 内部会员套餐摘要。
 * @returns 对外套餐 DTO。
 */
export function toMembershipPlanDto(
  plan: MembershipPlanSummary,
): MembershipPlanDto {
  return {
    plan_key: plan.planKey,
    name: plan.name,
    enabled: plan.enabled,
    monthly_price_coins: plan.monthlyPriceCoins,
    display_price_coins: plan.displayPriceCoins,
    updated_at: plan.updatedAt,
  };
}

/**
 * 将计费概览内部结构转换为 contract DTO。
 *
 * @param data 内部计费、钱包、会员摘要。
 * @returns 对外计费概览 DTO，并在兼容期同步输出旧字段。
 */
export function toBillingStatusDto(data: {
  billing: MonthlyMeteredBillingSummary;
  wallet: WalletBalanceSummary;
  membership: MembershipBillingSummary;
  membershipEntitlements: MembershipEntitlementRow[];
  membershipPlans: MembershipPlanSummary[];
}): BillingStatusDto {
  const monthlyChargedCoins = data.billing.chargedCoins;
  return {
    monthly_tokens_used: data.billing.usedTokens,
    monthly_charged_coins: monthlyChargedCoins,
    ...toWalletBalanceDto(data.wallet),
    membership: toMembershipStatusDto(data.membership),
    membership_entitlements: data.membershipEntitlements.map(
      toMembershipEntitlementDto,
    ),
    membership_plans: data.membershipPlans.map(toMembershipPlanDto),
  };
}

/**
 * 将会员订阅结果转换为 contract DTO。
 *
 * @param data 内部会员和钱包摘要。
 * @returns 对外订阅结果 DTO。
 */
export function toMembershipSubscribeResultDto(data: {
  membership: MembershipBillingSummary;
  wallet: WalletBalanceSummary;
}): MembershipSubscribeResultDto {
  return {
    membership: toMembershipStatusDto(data.membership),
    ...toWalletBalanceDto(data.wallet),
  };
}

/**
 * 保留用量统计 DTO 的 contract 边界入口。
 *
 * @param data repository 已返回 snake_case contract 字段。
 * @returns 原样返回的用量统计 DTO。
 */
export function toUsageStatsDto(data: UsageStatsDto): UsageStatsDto {
  return data;
}

/**
 * 保留每日用量列表 DTO 的 contract 边界入口。
 *
 * @param rows repository 已返回 snake_case contract 字段。
 * @returns 原样返回的每日用量 DTO 列表。
 */
export function toDailyUsageRowsDto(
  rows: DailyUsageRowDto[],
): DailyUsageRowDto[] {
  return rows;
}

/**
 * 保留钱包流水列表 DTO 的 contract 边界入口。
 *
 * @param rows repository 已返回 snake_case contract 字段。
 * @returns 原样返回的钱包流水 DTO 列表。
 */
export function toWalletTransactionsDto(
  rows: WalletTransactionDto[],
): WalletTransactionDto[] {
  return rows;
}

/**
 * 将充值订单行转换为 contract DTO。
 *
 * @param row repository 返回的充值订单行。
 * @returns 对外充值订单 DTO。
 */
export function toRechargeOrderDto(row: RechargeOrderRow): RechargeOrderDto {
  return {
    id: row.id,
    user_id: row.user_id,
    trade_id: row.trade_id,
    provider: row.provider,
    provider_trade_id: row.provider_trade_id,
    pay_type: row.pay_type,
    amount_coins: row.amount_coins,
    pay_url: row.pay_url,
    status: row.status,
    credit_status: row.credit_status,
    paid_at: row.paid_at,
    notified_at: row.notified_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 将充值订单列表转换为 contract DTO 列表。
 *
 * @param rows repository 返回的充值订单行列表。
 * @returns 对外充值订单 DTO 列表。
 */
export function toRechargeOrdersDto(
  rows: RechargeOrderRow[],
): RechargeOrderDto[] {
  return rows.map(toRechargeOrderDto);
}

/**
 * 将充值统计行转换为 contract DTO。
 *
 * @param row repository 返回的充值统计行。
 * @returns 对外充值统计 DTO。
 */
export function toRechargeStatsDto(row: RechargeStatsRow): RechargeStatsDto {
  return {
    total_paid_orders: row.total_paid_orders,
    total_recharge_coins: row.total_recharge_coins,
    last_paid_at: row.last_paid_at,
  };
}
