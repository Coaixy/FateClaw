import {
  getBillingRequestReservationByRequestId,
  getMonthlyModelChargeCoins,
  getUserById,
  releaseUserBalanceReservation,
  reserveUserBalanceCoins,
  settleUserModelChargeCoins,
} from '../../infrastructure/db.js';
import { getMonthlyTokenUsage } from '../../infrastructure/daily-usage.js';
import { resolveContextWindow } from '../../shared/model-context-window.js';
import type { LlmRuntimeSnapshot } from '../../runtime/ipc-payloads.js';

export interface BillingReservation {
  userId: string;
  requestId: string;
  reservedCoins: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
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

const REQUEST_RESERVE_INPUT_RATIO = 0.75;

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
    (input.promptTokens * input.inputTokenPricePerMillionCoins) / 1_000_000;
  const outputCost =
    (input.completionTokens * input.outputTokenPricePerMillionCoins) /
    1_000_000;
  return Math.ceil(inputCost + outputCost);
}

function estimateRequestReserve(runtime: LlmRuntimeSnapshot): {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostCoins: number;
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
    estimatedCostCoins: calculateTokenCostCoins({
      promptTokens: estimatedInputTokens,
      completionTokens: estimatedOutputTokens,
      inputTokenPricePerMillionCoins:
        runtime.inputTokenPricePerMillionCoins ?? 0,
      outputTokenPricePerMillionCoins:
        runtime.outputTokenPricePerMillionCoins ?? 0,
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
  const reservation = await reserveUserBalanceCoins({
    userId: input.userId,
    amountCoins: reserve.estimatedCostCoins,
    requestId: input.requestId,
    yearMonth,
    modelConfigId: input.runtime.modelConfigId,
    note: '模型请求开始，预扣 Token 费用',
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
    reservedCoins: reservation.reservedCoins,
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
  await releaseUserBalanceReservation(reservation.requestId, note);
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
    availableCoins: Math.max(
      0,
      user.purchased_coins + user.bonus_coins - user.reserved_coins,
    ),
  };
}
