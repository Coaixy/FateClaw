export const INSUFFICIENT_BALANCE_MESSAGE = '余额不足，请充值后继续使用';

export interface SpendableBalanceState {
  readonly purchased_cents: number;
  readonly bonus_cents: number;
  readonly reserved_cents: number;
}

export interface SpendableBalanceOptions {
  readonly releasedReservedCents?: number;
}

export function calculateAvailableSpendableCents(
  state: SpendableBalanceState,
  options: SpendableBalanceOptions = {},
): number {
  const releasedReservedCents = Math.max(
    0,
    options.releasedReservedCents ?? 0,
  );
  const effectiveReservedCents = Math.max(
    0,
    state.reserved_cents - releasedReservedCents,
  );

  return Math.max(
    0,
    state.purchased_cents + state.bonus_cents - effectiveReservedCents,
  );
}

export function assertSufficientSpendableCents(
  state: SpendableBalanceState,
  amountCents: number,
  options: SpendableBalanceOptions = {},
): void {
  if (amountCents <= 0) return;

  const availableCents = calculateAvailableSpendableCents(state, options);
  if (availableCents < amountCents) {
    throw new Error(INSUFFICIENT_BALANCE_MESSAGE);
  }
}
