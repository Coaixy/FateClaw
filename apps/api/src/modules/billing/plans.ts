import {
  expireUserBonusBalanceBefore,
  getBillingRequestReservationByRequestId,
  getMembershipConfig,
  getMembershipPlanConfigs,
  updateMembershipConfig,
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
  type SpendableBalanceState,
} from '../../shared/balance-coins.js';
import {
  normalizeMembershipPlanKey,
  resolveMembershipConfigId,
  resolveMembershipPlanKey,
} from '../../shared/membership-plans.js';
import { fail, ok, type ServiceResult } from '../../shared/service-result.js';

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
}

export interface MembershipPlanSummary {
  planKey: string;
  name: string;
  enabled: boolean;
  monthlyPriceCoins: number;
  displayPriceCoins: number;
  updatedAt: string;
}

/**
 * 单次计费结算摘要，用于前端展示积分实扣。
 *
 * @remarks 单层化后会员不含 AI 免费额度，故无会员抵扣字段。
 */
export interface BillingSettlementSummary {
  actualChargeCoins: number;
  rawChargeCoins: number;
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
    wallet?: SpendableBalanceState & { inArrears?: boolean };
  };
}): Promise<BillingReservation | null> {
  if (input.runtime.billingMode !== 'metered') {
    return null;
  }
  let walletState = input.entitlementSnapshot?.wallet;
  if (!walletState) {
    await expireUserBonusBalanceBefore(input.userId, new Date().toISOString());
    const user = await getUserById(input.userId);
    if (!user) {
      throw new Error('用户不存在');
    }
    walletState = user;
  }
  const inArrears =
    walletState.inArrears ?? isSpendableBalanceInArrears(walletState);
  if (inArrears) {
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
  // BYOK（自配模型，source==='custom'）用的是卦师自己的 API Key，平台不再按 token 计费，
  // 实现"使用权 / 余额"解耦：买了使用权即可自带 key 免费跑，余额只用于平台官方模型。
  if (
    input.runtime?.billingMode !== 'metered' ||
    input.runtime?.source === 'custom'
  ) {
    return {
      actualChargeCoins: 0,
      rawChargeCoins: 0,
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

export async function getMembershipBillingSummary(
  userId: string,
): Promise<MembershipBillingSummary> {
  const overview = await getMembershipOverview(userId);

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
  };
}

function membershipOverviewToBillingSummary(
  overview: Awaited<ReturnType<typeof getMembershipOverview>>,
): MembershipBillingSummary {
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
    updatedAt: config.updated_at,
  }));
}

/**
 * 读取全部会员套餐配置（含已停用），仅供管理后台改价界面使用。
 *
 * @returns 套餐摘要列表（不过滤 enabled）。
 * @remarks 用户侧只看在售（enabled）套餐；后台需看到全部以便切换启用状态。单层化后仅 clarity 一档。
 */
export async function getMembershipPlanConfigsForAdmin(): Promise<
  MembershipPlanSummary[]
> {
  const config = await getMembershipConfig();
  return [
    {
      planKey: resolveMembershipPlanKey(config.id),
      name: config.name,
      enabled: config.enabled,
      monthlyPriceCoins: config.monthly_price_coins,
      displayPriceCoins: config.display_price_coins,
      updatedAt: config.updated_at,
    },
  ];
}

/**
 * 管理后台更新会员套餐配置（价格 / 展示价 / 名称 / 启用状态）。
 *
 * 单层化后 planKey 实际只会是 clarity；其它值会被归一回 clarity。
 * 校验：价格非负、展示价不低于月费、名称非空。写入后无缓存层，
 * 用户侧下次 GET /api/billing 即读到新价。
 *
 * @param planKey 套餐 key（当前仅 clarity 有效）。
 * @param patch 可选更新字段。
 * @returns 成功返回更新后的套餐摘要；校验失败或套餐不存在返回 fail。
 */
export async function updateMembershipPlanConfig(
  planKey: string,
  patch: {
    monthlyPriceCoins?: number;
    displayPriceCoins?: number;
    name?: string;
    enabled?: boolean;
  },
): Promise<ServiceResult<MembershipPlanSummary>> {
  const normalizedPlanKey = normalizeMembershipPlanKey(planKey);
  const configId = resolveMembershipConfigId(normalizedPlanKey);

  if (
    patch.monthlyPriceCoins !== undefined &&
    (!Number.isFinite(patch.monthlyPriceCoins) || patch.monthlyPriceCoins < 0)
  ) {
    return fail(400, '月费积分不能为负数');
  }
  if (
    patch.displayPriceCoins !== undefined &&
    (!Number.isFinite(patch.displayPriceCoins) || patch.displayPriceCoins < 0)
  ) {
    return fail(400, '展示价积分不能为负数');
  }

  // 展示价不得低于月费：只传其一时，与 DB 当前值交叉校验。
  if (
    patch.monthlyPriceCoins !== undefined ||
    patch.displayPriceCoins !== undefined
  ) {
    const current = await getMembershipConfig(normalizedPlanKey);
    const finalMonthly = patch.monthlyPriceCoins ?? current.monthly_price_coins;
    const finalDisplay =
      patch.displayPriceCoins ?? current.display_price_coins;
    if (finalDisplay < finalMonthly) {
      return fail(400, '展示价积分不能低于月费积分');
    }
  }

  if (patch.name !== undefined && patch.name.trim().length === 0) {
    return fail(400, '套餐名称不能为空');
  }

  const updated = await updateMembershipConfig({
    id: configId,
    monthlyPriceCoins: patch.monthlyPriceCoins,
    displayPriceCoins: patch.displayPriceCoins,
    name: patch.name?.trim(),
    enabled: patch.enabled,
  });

  if (!updated) {
    return fail(404, '会员套餐配置不存在');
  }

  return ok({
    planKey: resolveMembershipPlanKey(updated.id),
    name: updated.name,
    enabled: updated.enabled,
    monthlyPriceCoins: updated.monthly_price_coins,
    displayPriceCoins: updated.display_price_coins,
    updatedAt: updated.updated_at,
  });
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
