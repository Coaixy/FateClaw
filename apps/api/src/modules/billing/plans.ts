import {
  getBillingRequestReservationByRequestId,
  getMonthlyModelChargeCents,
  getUserById,
  releaseUserBalanceReservation,
  reserveUserBalanceCents,
  settleUserModelChargeCents,
} from '../../infrastructure/db.js';
import { getMonthlyTokenUsage } from '../../infrastructure/daily-usage.js';
import { resolveContextWindow } from '../../shared/model-context-window.js';
import type { LlmRuntimeSnapshot } from '../../runtime/ipc-payloads.js';

export interface BillingReservation {
  userId: string;
  requestId: string;
  reservedCents: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  modelConfigId: string;
  yearMonth: string;
}

export interface WalletBalanceSummary {
  purchasedCents: number;
  bonusCents: number;
  earnedCents: number;
  reservedCents: number;
  availableCents: number;
  pendingWithdrawalCents: number;
}

export interface MonthlyMeteredBillingSummary {
  usedTokens: number;
  chargedCents: number;
}

const REQUEST_RESERVE_INPUT_RATIO = 0.75;

function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function calculateTokenCostCents(input: {
  promptTokens: number;
  completionTokens: number;
  inputTokenPricePerMillionCents: number;
  outputTokenPricePerMillionCents: number;
}): number {
  const inputCost =
    (input.promptTokens * input.inputTokenPricePerMillionCents) / 1_000_000;
  const outputCost =
    (input.completionTokens * input.outputTokenPricePerMillionCents) /
    1_000_000;
  return Math.ceil(inputCost + outputCost);
}

function estimateRequestReserve(runtime: LlmRuntimeSnapshot): {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostCents: number;
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
    estimatedCostCents: calculateTokenCostCents({
      promptTokens: estimatedInputTokens,
      completionTokens: estimatedOutputTokens,
      inputTokenPricePerMillionCents:
        runtime.inputTokenPricePerMillionCents ?? 0,
      outputTokenPricePerMillionCents:
        runtime.outputTokenPricePerMillionCents ?? 0,
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
  const reservation = await reserveUserBalanceCents({
    userId: input.userId,
    amountCents: reserve.estimatedCostCents,
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
    reservedCents: reservation.reservedCents,
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
  const costCents = calculateTokenCostCents({
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    inputTokenPricePerMillionCents:
      input.runtime.inputTokenPricePerMillionCents ?? 0,
    outputTokenPricePerMillionCents:
      input.runtime.outputTokenPricePerMillionCents ?? 0,
  });
  const result = await settleUserModelChargeCents(
    input.requestId,
    totalTokens,
    costCents,
  );
  return result.actualChargeCents;
}

export async function getMonthlyMeteredBillingSummary(
  userId: string,
): Promise<MonthlyMeteredBillingSummary> {
  const [usedTokens, chargedCents] = await Promise.all([
    getMonthlyTokenUsage(userId),
    getMonthlyModelChargeCents(userId),
  ]);
  return { usedTokens, chargedCents };
}

export async function getWalletBalanceSummary(
  userId: string,
): Promise<WalletBalanceSummary> {
  const user = await getUserById(userId);
  if (!user) {
    return {
      purchasedCents: 0,
      bonusCents: 0,
      earnedCents: 0,
      reservedCents: 0,
      availableCents: 0,
      pendingWithdrawalCents: 0,
    };
  }
  return {
    purchasedCents: user.purchased_cents,
    bonusCents: user.bonus_cents,
    earnedCents: user.earned_cents,
    reservedCents: user.reserved_cents,
    availableCents: Math.max(
      0,
      user.purchased_cents + user.bonus_cents - user.reserved_cents,
    ),
    pendingWithdrawalCents: user.pending_withdrawal_cents,
  };
}
