import { describe, expect, it } from 'vitest';

import {
  INSUFFICIENT_POINTS_MESSAGE,
  assertSufficientSpendablePoints,
  calculateAvailableSpendablePoints,
} from './point-balance.js';

describe('point balance guards', () => {
  it('blocks positive reservations when no spendable points are available', () => {
    expect(() =>
      assertSufficientSpendablePoints(
        { purchased_points: 0, bonus_points: 0, reserved_points: 0 },
        1,
      ),
    ).toThrow(INSUFFICIENT_POINTS_MESSAGE);
  });

  it('allows zero-cost requests without requiring a balance', () => {
    expect(() =>
      assertSufficientSpendablePoints(
        { purchased_points: 0, bonus_points: 0, reserved_points: 0 },
        0,
      ),
    ).not.toThrow();
  });

  it('counts the current request reservation as spendable during settlement', () => {
    const availablePoints = calculateAvailableSpendablePoints(
      { purchased_points: 100, bonus_points: 0, reserved_points: 100 },
      { releasedReservedPoints: 100 },
    );

    expect(availablePoints).toBe(100);
  });
});
