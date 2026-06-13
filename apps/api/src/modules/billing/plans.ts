import {
  getBillingRequestReservationByRequestId,
  getMembershipPlanConfigs,
  getMembershipOverview,
  getMonthlyModelChargeCoins,
  getUserById,
  reserveUserBalanceCoins,
  settleUserModelChargeCoins,
} from '../../infrastructure/db.js';
import { getMonthlyTokenUsage } from '../../infrastructure/daily-usage.js';
import type { LlmRuntimeSnapshot } from '../../runtime/ipc-payloads.js';
import { resolveMembershipAllowancePeriod } from '../../shared/membership-cycle.js';

export interface BillingReservation {
  userId: string;
  requestId: string;
  reservedCoins: 0;
  modelConfigId: string;
  yearMonth: string;
}

export interface WalletBalanceSummary {
  purchasedCoins: number;
  bonusCoins: number;
  reservedCoins: number;
  availableCoins: number;
}

export interface MonthlyMeteredBillingSummary {
  usedTokens: number;
  chargedCoins: number;
}

export interface MembershipBillingSummary {
  enabled: boolean;
  active: boolean;
  planKey: string | null;
  monthlyPriceCoins: number;
  displayPriceCoins: number;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  allowanceResetAt: string | null;
  allowanceUsedRatio: number;
  allowanceStatus:
    | 'inactive'
    | 'plenty'
    | 'normal'
    | 'tight'
    | 'almost_used'
    | 'used_up';
}

export interface MembershipPlanSummary {
  planKey: string;
  name: string;
  enabled: boolean;
  monthlyPriceCoins: number;
  displayPriceCoins: number;
  monthlyAllowanceUnits: number;
  standardPricePerMillionUnitsCoins: number;
  updatedAt: string;
}

/**
 * 单次计费结算摘要，用于前端展示钱包实扣和会员抵扣。
 */
export interface BillingSettlementSummary {
  actualChargeCoins: number;
  rawChargeCoins: number;
  membershipCoveredCoins: number;
  membershipConsumedUnits: number;
}

const TOKEN_PRICE_DENOMINATOR = 1_000_000;
const COIN_CENTS = 100;
export const BILLING_ARREARS_MESSAGE = '余额已欠费，请充值后继续使用';

function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function roundCoinsToCents(coins: number): number {
  if (!Number.isFinite(coins) || coins <= 0) return 0;
  return Math.round(coins * COIN_CENTS) / COIN_CENTS;
}

function calculateTokenCostCoins(input: {
  promptTokens: number;
  completionTokens: number;
  inputTokenPricePerMillionCoins: number;
  outputTokenPricePerMillionCoins: number;
}): number {
  const inputCost =
    (input.promptTokens * input.inputTokenPricePerMillionCoins) /
    TOKEN_PRICE_DENOMINATOR;
  const outputCost =
    (input.completionTokens * input.outputTokenPricePerMillionCoins) /
    TOKEN_PRICE_DENOMINATOR;
  return roundCoinsToCents(inputCost + outputCost);
}

export async function reserveBillingForRequest(input: {
  userId: string;
  requestId: string;
  runtime: LlmRuntimeSnapshot;
}): Promise<BillingReservation | null> {
  if (input.runtime.billingMode !== 'metered') {
    return null;
  }
  const user = await getUserById(input.userId);
  if (!user) {
    throw new Error('用户不存在');
  }
  if (user.purchased_coins + user.bonus_coins < 0) {
    throw new Error(BILLING_ARREARS_MESSAGE);
  }
  const yearMonth = currentYearMonth();
  const reservation = await reserveUserBalanceCoins({
    userId: input.userId,
    amountCoins: 0,
    requestId: input.requestId,
    yearMonth,
    modelConfigId: input.runtime.modelConfigId,
    note: '模型请求开始，登记待结算 Token 费用',
    metadata: {
      source: input.runtime.source,
      billingMode: input.runtime.billingMode,
      modelConfigId: input.runtime.modelConfigId,
      model: input.runtime.model,
    },
  });

  return {
    userId: input.userId,
    requestId: input.requestId,
    reservedCoins: 0,
    modelConfigId: input.runtime.modelConfigId,
    yearMonth,
  };
}

/**
 * 按模型 Token 用量完成计费结算，并返回原始费用、会员抵扣和钱包实扣明细。
 */
export async function settleBillingReservationDetailed(input: {
  requestId: string;
  runtime?: LlmRuntimeSnapshot | null;
  promptTokens: number;
  completionTokens: number;
}): Promise<BillingSettlementSummary> {
  if (input.runtime?.billingMode !== 'metered') {
    return {
      actualChargeCoins: 0,
      rawChargeCoins: 0,
      membershipCoveredCoins: 0,
      membershipConsumedUnits: 0,
    };
  }
  const reservation = await getBillingRequestReservationByRequestId(
    input.requestId,
  );
  if (!reservation) {
    return {
      actualChargeCoins: 0,
      rawChargeCoins: 0,
      membershipCoveredCoins: 0,
      membershipConsumedUnits: 0,
    };
  }
  const totalTokens = input.promptTokens + input.completionTokens;
  const costCoins = calculateTokenCostCoins({
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    inputTokenPricePerMillionCoins:
      input.runtime.inputTokenPricePerMillionCoins ?? 0,
    outputTokenPricePerMillionCoins:
      input.runtime.outputTokenPricePerMillionCoins ?? 0,
  });
  const result = await settleUserModelChargeCoins(
    input.requestId,
    totalTokens,
    costCoins,
  );
  return {
    actualChargeCoins: result.actualChargeCoins,
    rawChargeCoins: result.rawChargeCoins,
    membershipCoveredCoins: result.membershipCoveredCoins,
    membershipConsumedUnits: result.membershipConsumedUnits,
  };
}

export async function settleBillingReservation(input: {
  requestId: string;
  runtime?: LlmRuntimeSnapshot | null;
  promptTokens: number;
  completionTokens: number;
}): Promise<number> {
  const result = await settleBillingReservationDetailed(input);
  return result.actualChargeCoins;
}

export async function getMonthlyMeteredBillingSummary(
  userId: string,
): Promise<MonthlyMeteredBillingSummary> {
  const [usedTokens, chargedCoins] = await Promise.all([
    getMonthlyTokenUsage(userId),
    getMonthlyModelChargeCoins(userId),
  ]);
  return { usedTokens, chargedCoins };
}

function resolveAllowanceStatus(
  active: boolean,
  usedRatio: number,
): MembershipBillingSummary['allowanceStatus'] {
  if (!active) return 'inactive';
  if (usedRatio >= 1) return 'used_up';
  if (usedRatio >= 0.95) return 'almost_used';
  if (usedRatio >= 0.8) return 'tight';
  if (usedRatio >= 0.5) return 'normal';
  return 'plenty';
}

export async function getMembershipBillingSummary(
  userId: string,
): Promise<MembershipBillingSummary> {
  const overview = await getMembershipOverview(userId);
  const allowancePeriod = overview.membership
    ? resolveMembershipAllowancePeriod(overview.membership)
    : null;
  const allowanceUnits =
    overview.allowance?.allowance_units ??
    (overview.active ? overview.config.monthly_allowance_units : 0);
  const usedUnits = overview.allowance?.used_units ?? 0;
  const usedRatio =
    allowanceUnits > 0 ? Math.min(1, usedUnits / allowanceUnits) : 0;

  return {
    enabled: overview.config.enabled,
    active: overview.active,
    planKey: overview.membership?.plan_key ?? null,
    monthlyPriceCoins: overview.config.monthly_price_coins,
    displayPriceCoins: overview.config.display_price_coins,
    currentPeriodStart: overview.active
      ? (overview.membership?.current_period_start ?? null)
      : null,
    currentPeriodEnd: overview.active
      ? (overview.membership?.current_period_end ?? null)
      : null,
    allowanceResetAt: overview.active
      ? (overview.allowance?.period_end ?? allowancePeriod?.end ?? null)
      : null,
    allowanceUsedRatio: Math.round(usedRatio * 10000) / 10000,
    allowanceStatus: resolveAllowanceStatus(overview.active, usedRatio),
  };
}

export async function getMembershipPlanSummaries(): Promise<
  MembershipPlanSummary[]
> {
  const configs = await getMembershipPlanConfigs();
  return configs.map((config) => ({
    planKey: config.id === 'fateclaw_pro' ? 'fateclaw_pro' : 'fateclaw_plus',
    name: config.name,
    enabled: config.enabled,
    monthlyPriceCoins: config.monthly_price_coins,
    displayPriceCoins: config.display_price_coins,
    monthlyAllowanceUnits: config.monthly_allowance_units,
    standardPricePerMillionUnitsCoins:
      config.standard_price_per_million_units_coins,
    updatedAt: config.updated_at,
  }));
}

export async function getWalletBalanceSummary(
  userId: string,
): Promise<WalletBalanceSummary> {
  const user = await getUserById(userId);
  if (!user) {
    return {
      purchasedCoins: 0,
      bonusCoins: 0,
      reservedCoins: 0,
      availableCoins: 0,
    };
  }
  return {
    purchasedCoins: user.purchased_coins,
    bonusCoins: user.bonus_coins,
    reservedCoins: user.reserved_coins,
    availableCoins: user.purchased_coins + user.bonus_coins,
  };
}
