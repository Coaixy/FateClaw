import {
  expireUserBonusBalanceBefore,
  getBillingRequestReservationByRequestId,
  getMembershipPlanConfigs,
  getMembershipOverview,
  getMembershipOverviewsByUserIds,
  getMonthlyModelChargeCoins,
  getMonthlyModelChargeCoinsByUserIds,
  getUserById,
  reserveUserBalanceCoins,
  settleUserModelChargeCoins,
} from '../../infrastructure/db.js';
import {
  getMonthlyTokenUsage,
  getMonthlyTokenUsageByUserIds,
} from '../../infrastructure/daily-usage.js';
import { logger } from '../../infrastructure/logger.js';
import type { LlmRuntimeSnapshot } from '../../runtime/ipc-payloads.js';
import {
  calculateAvailableSpendableCoins,
  isSpendableBalanceInArrears,
} from '../../shared/balance-coins.js';
import { resolveMembershipAllowancePeriod } from '../../shared/membership-cycle.js';
import {
  normalizeMembershipPlanKey,
  resolveMembershipPlanKey,
} from '../../shared/membership-plans.js';

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
  inArrears: boolean;
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
 * 单次计费结算摘要，用于前端展示积分实扣和会员免费额度抵扣。
 */
export interface BillingSettlementSummary {
  actualChargeCoins: number;
  rawChargeCoins: number;
  membershipCoveredCoins: number;
  membershipConsumedUnits: number;
  missingReservation?: boolean;
}

const TOKEN_PRICE_DENOMINATOR = 1_000_000;
const COIN_CENTS = 100;
export const BILLING_ARREARS_MESSAGE = '积分已欠费，请补充积分后继续使用';

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
  entitlementSnapshot?: {
    planKey: string | null;
    membershipActive: boolean;
    availableCoins: number;
  };
}): Promise<BillingReservation | null> {
  if (input.runtime.billingMode !== 'metered') {
    return null;
  }
  await expireUserBonusBalanceBefore(input.userId, new Date().toISOString());
  const user = await getUserById(input.userId);
  if (!user) {
    throw new Error('用户不存在');
  }
  if (isSpendableBalanceInArrears(user)) {
    throw new Error(BILLING_ARREARS_MESSAGE);
  }
  const yearMonth = currentYearMonth();
  await reserveUserBalanceCoins({
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
      entitlementSnapshot: input.entitlementSnapshot ?? null,
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
 * 按模型 Token 用量完成计费结算，并返回原始费用、会员免费额度抵扣和积分实扣明细。
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
    logger.warn(
      {
        requestId: input.requestId,
        modelConfigId: input.runtime.modelConfigId,
        runtimeSource: input.runtime.source,
      },
      '计费结算缺失待结算记录',
    );
    return {
      actualChargeCoins: 0,
      rawChargeCoins: 0,
      membershipCoveredCoins: 0,
      membershipConsumedUnits: 0,
      missingReservation: true,
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

/**
 * 批量读取用户当月 metered 模型用量与扣费。
 *
 * @param userIds 当前页用户 ID 列表。
 * @returns userId 到月用量/扣费汇总的映射。
 */
export async function getMonthlyMeteredBillingSummariesByUserIds(
  userIds: string[],
): Promise<Map<string, MonthlyMeteredBillingSummary>> {
  const [usedTokensByUser, chargedCoinsByUser] = await Promise.all([
    getMonthlyTokenUsageByUserIds(userIds),
    getMonthlyModelChargeCoinsByUserIds(userIds),
  ]);
  return new Map(
    userIds.map((userId) => [
      userId,
      {
        usedTokens: usedTokensByUser.get(userId) ?? 0,
        chargedCoins: chargedCoinsByUser.get(userId) ?? 0,
      },
    ]),
  );
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
    planKey: overview.membership?.plan_key
      ? normalizeMembershipPlanKey(overview.membership.plan_key)
      : null,
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

function membershipOverviewToBillingSummary(
  overview: Awaited<ReturnType<typeof getMembershipOverview>>,
): MembershipBillingSummary {
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
    planKey: overview.membership?.plan_key
      ? normalizeMembershipPlanKey(overview.membership.plan_key)
      : null,
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

/**
 * 批量读取用户会员结算摘要。
 *
 * @param userIds 当前页用户 ID 列表。
 * @returns userId 到会员状态摘要的映射。
 */
export async function getMembershipBillingSummariesByUserIds(
  userIds: string[],
): Promise<Map<string, MembershipBillingSummary>> {
  const overviews = await getMembershipOverviewsByUserIds(userIds);
  return new Map(
    userIds.map((userId) => {
      const overview = overviews.get(userId);
      if (!overview) {
        return [
          userId,
          {
            enabled: false,
            active: false,
            planKey: null,
            monthlyPriceCoins: 0,
            displayPriceCoins: 0,
            currentPeriodStart: null,
            currentPeriodEnd: null,
            allowanceResetAt: null,
            allowanceUsedRatio: 0,
            allowanceStatus: 'inactive',
          } satisfies MembershipBillingSummary,
        ] as const;
      }
      return [userId, membershipOverviewToBillingSummary(overview)] as const;
    }),
  );
}

export async function getMembershipPlanSummaries(): Promise<
  MembershipPlanSummary[]
> {
  const configs = await getMembershipPlanConfigs();
  return configs.map((config) => ({
    planKey: resolveMembershipPlanKey(config.id),
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
      inArrears: false,
    };
  }
  return {
    purchasedCoins: user.purchased_coins,
    bonusCoins: user.bonus_coins,
    reservedCoins: user.reserved_coins,
    availableCoins: calculateAvailableSpendableCoins(user),
    inArrears: isSpendableBalanceInArrears(user),
  };
}
