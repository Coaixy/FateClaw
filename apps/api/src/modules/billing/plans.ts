import {
  getBillingRequestReservationByRequestId,
  getMonthlyModelChargePoints,
  getUserById,
  releaseUserReservation,
  reserveUserPoints,
  settleUserModelChargePoints,
} from '../../infrastructure/db.js';
import { getMonthlyTokenUsage } from '../../infrastructure/daily-usage.js';
import { resolveContextWindow } from '../../shared/model-context-window.js';
import type { LlmRuntimeSnapshot } from '../../runtime/ipc-payloads.js';

export interface BillingReservation {
  userId: string;
  requestId: string;
  reservedPoints: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  modelConfigId: string;
  yearMonth: string;
}

export interface WalletBalanceSummary {
  purchasedPoints: number;
  bonusPoints: number;
  earnedPoints: number;
  reservedPoints: number;
  availablePoints: number;
  pendingWithdrawalPoints: number;
}

export interface MonthlyMeteredBillingSummary {
  usedTokens: number;
  chargedPoints: number;
}

const REQUEST_RESERVE_INPUT_RATIO = 0.75;

function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function calculateTokenCostPoints(input: {
  promptTokens: number;
  completionTokens: number;
  inputTokenPricePerMillionPoints: number;
  outputTokenPricePerMillionPoints: number;
}): number {
  const inputCost =
    (input.promptTokens * input.inputTokenPricePerMillionPoints) / 1_000_000;
  const outputCost =
    (input.completionTokens * input.outputTokenPricePerMillionPoints) /
    1_000_000;
  return Math.ceil(inputCost + outputCost);
}

function estimateRequestReserve(runtime: LlmRuntimeSnapshot): {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostPoints: number;
} {
  const contextWindow = resolveContextWindow({
    model: runtime.model,
    configured: runtime.contextWindowTokens,
  });
  const estimatedInputTokens = Math.ceil(
    contextWindow * REQUEST_RESERVE_INPUT_RATIO,
  );
  const estimatedOutputTokens = Math.max(
    0,
    contextWindow - estimatedInputTokens,
  );
  return {
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCostPoints: calculateTokenCostPoints({
      promptTokens: estimatedInputTokens,
      completionTokens: estimatedOutputTokens,
      inputTokenPricePerMillionPoints:
        runtime.inputTokenPricePerMillionPoints ?? 0,
      outputTokenPricePerMillionPoints:
        runtime.outputTokenPricePerMillionPoints ?? 0,
    }),
  };
}

export async function reserveBillingForRequest(input: {
  userId: string;
  requestId: string;
  runtime: LlmRuntimeSnapshot;
}): Promise<BillingReservation | null> {
  if (input.runtime.billingMode !== 'metered') {
    return null;
  }
  const reserve = estimateRequestReserve(input.runtime);
  const yearMonth = currentYearMonth();
  const reservation = await reserveUserPoints({
    userId: input.userId,
    amountPoints: reserve.estimatedCostPoints,
    requestId: input.requestId,
    yearMonth,
    modelConfigId: input.runtime.modelConfigId,
    note: '官方模型请求开始，预扣 Token 费用',
    metadata: {
      source: input.runtime.source,
      billingMode: input.runtime.billingMode,
      modelConfigId: input.runtime.modelConfigId,
      model: input.runtime.model,
      estimatedInputTokens: reserve.estimatedInputTokens,
      estimatedOutputTokens: reserve.estimatedOutputTokens,
    },
  });

  return {
    userId: input.userId,
    requestId: input.requestId,
    reservedPoints: reservation.reservedPoints,
    estimatedInputTokens: reserve.estimatedInputTokens,
    estimatedOutputTokens: reserve.estimatedOutputTokens,
    modelConfigId: input.runtime.modelConfigId,
    yearMonth,
  };
}

export async function releaseBillingReservation(
  reservation: BillingReservation | null | undefined,
  note: string,
): Promise<void> {
  if (!reservation) return;
  await releaseUserReservation(reservation.requestId, note);
}

export async function settleBillingReservation(input: {
  requestId: string;
  runtime?: LlmRuntimeSnapshot | null;
  promptTokens: number;
  completionTokens: number;
}): Promise<number> {
  if (input.runtime?.billingMode !== 'metered') {
    return 0;
  }
  const reservation = await getBillingRequestReservationByRequestId(
    input.requestId,
  );
  if (!reservation) return 0;
  const totalTokens = input.promptTokens + input.completionTokens;
  const costPoints = calculateTokenCostPoints({
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    inputTokenPricePerMillionPoints:
      input.runtime.inputTokenPricePerMillionPoints ?? 0,
    outputTokenPricePerMillionPoints:
      input.runtime.outputTokenPricePerMillionPoints ?? 0,
  });
  const result = await settleUserModelChargePoints(
    input.requestId,
    totalTokens,
    costPoints,
  );
  return result.actualChargePoints;
}

export async function getMonthlyMeteredBillingSummary(
  userId: string,
): Promise<MonthlyMeteredBillingSummary> {
  const [usedTokens, chargedPoints] = await Promise.all([
    getMonthlyTokenUsage(userId),
    getMonthlyModelChargePoints(userId),
  ]);
  return { usedTokens, chargedPoints };
}

export async function getWalletBalanceSummary(
  userId: string,
): Promise<WalletBalanceSummary> {
  const user = await getUserById(userId);
  if (!user) {
    return {
      purchasedPoints: 0,
      bonusPoints: 0,
      earnedPoints: 0,
      reservedPoints: 0,
      availablePoints: 0,
      pendingWithdrawalPoints: 0,
    };
  }
  return {
    purchasedPoints: user.purchased_points,
    bonusPoints: user.bonus_points,
    earnedPoints: user.earned_points,
    reservedPoints: user.reserved_points,
    availablePoints: Math.max(
      0,
      user.purchased_points + user.bonus_points - user.reserved_points,
    ),
    pendingWithdrawalPoints: user.pending_withdrawal_points,
  };
}
