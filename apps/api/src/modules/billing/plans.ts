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
  /** 本次请求冻结进 reserved_coins 的预估额(coins),结算时按真实费用多退少补后释放。 */
  reservedCoins: number;
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

// 预留(冻结)金额估算的保守参数。
// 说明:冻结额的作用是「限流并发 + 封顶单 turn 漏结算的损失」,而非精确计费
// (精确扣费由 settle 按真实 usage 完成),因此取一个适中的保守上限即可:
// 过大反而会冻结远超实际成本的余额、过早拦住后续请求、在前端显示吓人的冻结额;
// 单 turn 实际超出预估时,差额由 settle 据实多扣,并由下一次请求入口因欠费而拦截,
// 损失天然封顶在「一次请求的溢出」内。两个常量可按线上观测调优。
const ESTIMATE_PROMPT_TOKENS = 32_000;
const ESTIMATE_MAX_OUTPUT_TOKENS = 8_000;
const MIN_RESERVE_COINS = 0.01;

/**
 * 估算单次模型请求需冻结的 coins(用于请求前预留)。
 *
 * @param runtime 当前请求的模型运行时快照(含输入/输出单价、上下文窗口、最大输出)。
 * @returns 不小于 MIN_RESERVE_COINS 的预估冻结额;按「保守 prompt 估算 + 最大输出」计价。
 * @remarks 仅供冻结/限流使用,非最终账单。单价缺失(理论上不应 metered)时退化为最小冻结额,
 *          确保预留始终持有非零额度,避免预留形同虚设。
 */
export function estimateRequestReserveCoins(runtime: LlmRuntimeSnapshot): number {
  const inputPrice = runtime.inputTokenPricePerMillionCoins ?? 0;
  const outputPrice = runtime.outputTokenPricePerMillionCoins ?? 0;
  const promptTokens = Math.min(
    runtime.contextWindowTokens ?? ESTIMATE_PROMPT_TOKENS,
    ESTIMATE_PROMPT_TOKENS,
  );
  const outputTokens = runtime.maxOutputTokens ?? ESTIMATE_MAX_OUTPUT_TOKENS;
  const estimate =
    (promptTokens * inputPrice) / TOKEN_PRICE_DENOMINATOR +
    (outputTokens * outputPrice) / TOKEN_PRICE_DENOMINATOR;
  return Math.max(roundCoinsToCents(estimate), MIN_RESERVE_COINS);
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
  // 快照层面的欠费预检:提供清晰的面向用户文案并快速失败。
  // 真正并发安全的余额关卡在 reserveUserBalanceCoins 的原子条件 UPDATE 中(rowCount=0 即拒)。
  const inArrears =
    walletState.inArrears ?? isSpendableBalanceInArrears(walletState);
  if (inArrears) {
    throw new Error(BILLING_ARREARS_MESSAGE);
  }
  const estimateCoins = estimateRequestReserveCoins(input.runtime);
  const yearMonth = currentYearMonth();
  // 原子冻结预估额:并发第二笔会看到已抬高的 reserved 而被拒,杜绝并发透支;
  // 余额不足(已欠费)时本调用抛错,请求不会进入运行时,不产生 token 消耗。
  const reservation = await reserveUserBalanceCoins({
    userId: input.userId,
    amountCoins: estimateCoins,
    requestId: input.requestId,
    yearMonth,
    modelConfigId: input.runtime.modelConfigId,
    note: '模型请求开始，冻结预估 Token 费用',
    metadata: {
      source: input.runtime.source,
      billingMode: input.runtime.billingMode,
      modelConfigId: input.runtime.modelConfigId,
      model: input.runtime.model,
      estimateReserveCoins: estimateCoins,
      entitlementSnapshot: input.entitlementSnapshot ?? null,
    },
  });

  return {
    userId: input.userId,
    requestId: input.requestId,
    reservedCoins: reservation.reservedCoins,
    modelConfigId: input.runtime.modelConfigId,
    yearMonth,
  };
}

/**
 * 按模型 Token 用量完成计费结算，并返回原始费用、会员免费额度抵扣和积分实扣明细。
 */
// 最小计费单位:有真实用量但费用不足一分(亚分被取整为 0)时,按此下限计费,
// 避免极短/低价请求免费。与冻结估算的最小额一致(一分)。
const MIN_CHARGE_COINS = 0.01;

export async function settleBillingReservationDetailed(input: {
  requestId: string;
  runtime?: LlmRuntimeSnapshot | null;
  promptTokens: number;
  completionTokens: number;
  // 成功完成但缺失真实 usage 时,是否回退按预冻结额入账(防"成功却 0 usage 免单")。
  // 仅对成功 turn 传 true;失败 turn 传 false —— 失败若确有消耗会经 partialUsage 上报为
  // totalTokens>0,故 totalTokens<=0 的失败视为真正零消耗,不应误扣。
  chargeReserveOnMissingUsage?: boolean;
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
  let costCoins = calculateTokenCostCoins({
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    inputTokenPricePerMillionCoins:
      input.runtime.inputTokenPricePerMillionCoins ?? 0,
    outputTokenPricePerMillionCoins:
      input.runtime.outputTokenPricePerMillionCoins ?? 0,
  });
  let noteOverride: string | undefined;
  if (totalTokens <= 0) {
    // 没有真实用量。成功完成的 metered turn 却报 0 usage(provider 未回/流式异常/被代理
    // 吞掉)是异常:不能免单,回退按预冻结额入账并告警。失败 turn(及无冻结额)保持 0,
    // 结算仍会释放冻结并置 charged。
    if (input.chargeReserveOnMissingUsage && reservation.reserved_coins > 0) {
      costCoins = reservation.reserved_coins;
      noteOverride = '真实用量缺失,按预冻结额入账';
      logger.warn(
        {
          requestId: input.requestId,
          modelConfigId: input.runtime.modelConfigId,
          reservedCoins: reservation.reserved_coins,
        },
        'metered 成功请求缺失真实 usage,回退按预冻结额计费',
      );
    }
  } else {
    // 有真实用量:设最小计费,避免亚分被取整为 0 的极短请求免费。
    costCoins = Math.max(costCoins, MIN_CHARGE_COINS);
  }
  const result = await settleUserModelChargeCoins(
    input.requestId,
    totalTokens,
    costCoins,
    noteOverride,
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
  chargeReserveOnMissingUsage?: boolean;
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
