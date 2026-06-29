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
  roundCoinsToCents,
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
export const BILLING_ARREARS_MESSAGE = '积分已欠费，请补充积分后继续使用';
export const BILLING_PRICE_MISCONFIGURED_MESSAGE =
  '模型计费未正确配置，请联系管理员';

/** 从预留 metadata 中安全读取数值字段；非有限数回退 0。 */
function numberFromMetaOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
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

/**
 * 非会员专家模式加价系数。
 *
 * 专家模式（AI 解读）已对非会员放开：非会员可发起，但平台官方计费模型按此倍率
 * 抬高 token 单价——既扩大散户转化漏斗，又保住会员的价格落差。会员仍享原价。
 *
 * @remarks MVP 以常量固化；后续若需运营自助调价，再迁到配置表 / 环境变量。
 */
export const NON_MEMBER_PRICE_MULTIPLIER = 1.5;

/**
 * 对非会员请求的平台计费模型应用加价系数，返回价格抬高后的新 runtime 快照。
 *
 * 设计要点：加价被「烙进」runtime 快照的 token 单价字段。由于该快照贯穿
 * reserve（写入预留 metadata）→ settle（直接复用 pending.llmRuntime）→
 * sweeper recover（读回 metadata 价格）三处，**一处加价即三处自动一致**，
 * 无需在每个计费函数里各自传系数。
 *
 * 豁免（原样返回、不加价）：
 *  - 会员（membershipActive === true）：享原价；
 *  - BYOK 自配模型（runtime.source === 'custom'）：结算恒 0，加价无意义；
 *  - 非计费模型（runtime.billingMode !== 'metered'）：本就不扣费。
 *
 * @param runtime 待计费的 LLM 运行时快照。
 * @param membershipActive 是否为有效会员（取自 entitlement 快照）。
 * @returns 会员 / 豁免场景返回原 runtime；非会员计费模型返回价格 ×系数 的新快照。
 */
export function applyNonMemberPricingMarkup(
  runtime: LlmRuntimeSnapshot,
  membershipActive: boolean,
): LlmRuntimeSnapshot {
  // 豁免（原价返回）：会员享原价；BYOK 自配（custom）结算恒 0、加价无意义；
  // 非计费模型（billingMode!=='metered'）本就不扣费。任一命中即原样返回。
  if (
    membershipActive ||
    runtime.source === 'custom' ||
    runtime.billingMode !== 'metered'
  ) {
    return runtime;
  }
  // 非会员 metered 官方模型：input/output 单价同步 ×系数，返回新快照
  //（不原地改 runtime，避免共享引用被意外污染）。单价可选，以 ?? 0 兜底后再乘，
  // 与 reserve/settle 里既有的 `?? 0` 口径保持一致。
  return {
    ...runtime,
    inputTokenPricePerMillionCoins:
      (runtime.inputTokenPricePerMillionCoins ?? 0) *
      NON_MEMBER_PRICE_MULTIPLIER,
    outputTokenPricePerMillionCoins:
      (runtime.outputTokenPricePerMillionCoins ?? 0) *
      NON_MEMBER_PRICE_MULTIPLIER,
  };
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

  // metered 官方模型必须有正价。否则计费流程照常跑、结算成本却恒为 0（免费白嫖）。
  // 输入/输出价格只要其一 ≤0 就告警留痕（疑似漏配某档价格）；
  // 两者都 ≤0 则视为彻底误配，直接拒绝起请求，避免静默漏收。
  // BYOK（source==='custom'）自带 key、结算本就为 0，不要求平台价，跳过本校验。
  const inputPrice = input.runtime.inputTokenPricePerMillionCoins ?? 0;
  const outputPrice = input.runtime.outputTokenPricePerMillionCoins ?? 0;
  if (input.runtime.source !== 'custom') {
    if (inputPrice <= 0 || outputPrice <= 0) {
      logger.warn(
        {
          userId: input.userId,
          modelConfigId: input.runtime.modelConfigId,
          model: input.runtime.model,
          inputPrice,
          outputPrice,
        },
        'metered 模型存在 ≤0 价格，疑似计费配置缺失',
      );
    }
    if (inputPrice <= 0 && outputPrice <= 0) {
      throw new Error(BILLING_PRICE_MISCONFIGURED_MESSAGE);
    }
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
      // 记录"当时价格"：sweeper 兜底结算陈旧预留时按下单时价重算，
      // 避免管理员事后改价导致补结算金额与用户实际请求时不一致。
      inputTokenPricePerMillionCoins: inputPrice,
      outputTokenPricePerMillionCoins: outputPrice,
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

/**
 * 兜底结算一条陈旧的未结算预留（供 billing-sweeper 调用）。
 *
 * 正常结算依赖 API 进程内存里的 pending（携带 runtime 价格）；当请求被取消、超时、
 * 或进程重启导致 pending 丢失时，结算被跳过、预留行永久停在 charge_state='pending'。
 * 本函数不依赖内存态：从预留 metadata 取下单时记录的价格，配合调用方从对话日志找回的
 * 真实 usage 重算成本并实扣；非 metered / BYOK / 找不回 usage 时以 0 关账，
 * 确保悬挂预留被收尾、不再被反复扫描。
 *
 * @param input.requestId 预留对应的请求 ID。
 * @param input.promptTokens 从对话日志找回的真实输入 Token（找不回传 0）。
 * @param input.completionTokens 从对话日志找回的真实输出 Token（找不回传 0）。
 * @returns 结算摘要；预留不存在或已结算时返回 null。
 * @remarks settleUserModelChargeCoins 以 charge_state 幂等，本函数与正常结算并发安全。
 */
export async function recoverStalePendingReservation(input: {
  requestId: string;
  promptTokens: number;
  completionTokens: number;
}): Promise<BillingSettlementSummary | null> {
  const reservation = await getBillingRequestReservationByRequestId(
    input.requestId,
  );
  if (!reservation || reservation.charge_state === 'charged') {
    return null;
  }

  const metadata = (reservation.metadata ?? {}) as Record<string, unknown>;
  const isMetered = metadata.billingMode === 'metered';
  const isCustom = metadata.source === 'custom';

  // 非 metered 或 BYOK：成本恒 0，直接以 0 关账收尾。
  if (!isMetered || isCustom) {
    const result = await settleUserModelChargeCoins(input.requestId, 0, 0);
    return {
      actualChargeCoins: result.actualChargeCoins,
      rawChargeCoins: result.rawChargeCoins,
    };
  }

  const totalTokens = input.promptTokens + input.completionTokens;
  const costCoins = calculateTokenCostCoins({
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    inputTokenPricePerMillionCoins: numberFromMetaOr0(
      metadata.inputTokenPricePerMillionCoins,
    ),
    outputTokenPricePerMillionCoins: numberFromMetaOr0(
      metadata.outputTokenPricePerMillionCoins,
    ),
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
    const finalDisplay = patch.displayPriceCoins ?? current.display_price_coins;
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
