export const INSUFFICIENT_POINTS_MESSAGE = '余额不足，请充值后继续使用';

export interface SpendablePointState {
  readonly purchased_points: number;
  readonly bonus_points: number;
  readonly reserved_points: number;
}

export interface SpendablePointOptions {
  readonly releasedReservedPoints?: number;
}

export function calculateAvailableSpendablePoints(
  state: SpendablePointState,
  options: SpendablePointOptions = {},
): number {
  const releasedReservedPoints = Math.max(
    0,
    options.releasedReservedPoints ?? 0,
  );
  const effectiveReservedPoints = Math.max(
    0,
    state.reserved_points - releasedReservedPoints,
  );

  return Math.max(
    0,
    state.purchased_points + state.bonus_points - effectiveReservedPoints,
  );
}

export function assertSufficientSpendablePoints(
  state: SpendablePointState,
  amountPoints: number,
  options: SpendablePointOptions = {},
): void {
  if (amountPoints <= 0) return;

  const availablePoints = calculateAvailableSpendablePoints(state, options);
  if (availablePoints < amountPoints) {
    throw new Error(INSUFFICIENT_POINTS_MESSAGE);
  }
}
