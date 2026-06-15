export const INSUFFICIENT_BALANCE_MESSAGE = '积分不足，请补充积分后继续使用';

export interface SpendableBalanceState {
  readonly purchased_coins: number;
  readonly bonus_coins: number;
  readonly reserved_coins: number;
}

export interface SpendableBalanceOptions {
  readonly releasedReservedCoins?: number;
}

export function calculateAvailableSpendableCoins(
  state: SpendableBalanceState,
  options: SpendableBalanceOptions = {},
): number {
  const releasedReservedCoins = Math.max(
    0,
    options.releasedReservedCoins ?? 0,
  );
  const effectiveReservedCoins = Math.max(
    0,
    state.reserved_coins - releasedReservedCoins,
  );

  return state.purchased_coins + state.bonus_coins - effectiveReservedCoins;
}

export function assertSufficientSpendableCoins(
  state: SpendableBalanceState,
  amountCoins: number,
  options: SpendableBalanceOptions = {},
): void {
  if (amountCoins <= 0) return;

  const availableCoins = calculateAvailableSpendableCoins(state, options);
  if (availableCoins < amountCoins) {
    throw new Error(INSUFFICIENT_BALANCE_MESSAGE);
  }
}
