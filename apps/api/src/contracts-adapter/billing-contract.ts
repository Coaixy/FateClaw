import type {
  BillingStatusDto,
  DailyUsageRowDto,
  RechargeOrderDto,
  RechargeStatsDto,
  UsageStatsDto,
  WalletTransactionDto,
} from '@nanoclaw/contracts/billing';

import type {
  RechargeOrderRow,
  RechargeStatsRow,
} from '../infrastructure/db.js';

export function toBillingStatusDto(data: BillingStatusDto): BillingStatusDto {
  return data;
}

export function toUsageStatsDto(data: UsageStatsDto): UsageStatsDto {
  return data;
}

export function toDailyUsageRowsDto(
  rows: DailyUsageRowDto[],
): DailyUsageRowDto[] {
  return rows;
}

export function toWalletTransactionsDto(
  rows: WalletTransactionDto[],
): WalletTransactionDto[] {
  return rows;
}

export function toRechargeOrderDto(row: RechargeOrderRow): RechargeOrderDto {
  return {
    id: row.id,
    user_id: row.user_id,
    trade_id: row.trade_id,
    provider: row.provider,
    provider_trade_id: row.provider_trade_id,
    pay_type: row.pay_type,
    amount_yuan: row.amount_yuan,
    amount_points: row.amount_points,
    pay_url: row.pay_url,
    status: row.status,
    paid_at: row.paid_at,
    notified_at: row.notified_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toRechargeOrdersDto(
  rows: RechargeOrderRow[],
): RechargeOrderDto[] {
  return rows.map(toRechargeOrderDto);
}

export function toRechargeStatsDto(row: RechargeStatsRow): RechargeStatsDto {
  return {
    total_paid_orders: row.total_paid_orders,
    total_recharge_points: row.total_recharge_points,
    total_recharge_yuan: row.total_recharge_yuan,
    last_paid_at: row.last_paid_at,
  };
}
