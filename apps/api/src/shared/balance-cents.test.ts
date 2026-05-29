import { describe, expect, it } from 'vitest';

import {
  INSUFFICIENT_BALANCE_MESSAGE,
  assertSufficientSpendableCents,
  calculateAvailableSpendableCents,
} from './balance-cents.js';

describe('balance cents guards', () => {
  it('blocks positive reservations when no spendable balance is available', () => {
    expect(() =>
      assertSufficientSpendableCents(
        { purchased_cents: 0, bonus_cents: 0, reserved_cents: 0 },
        1,
      ),
    ).toThrow(INSUFFICIENT_BALANCE_MESSAGE);
  });

  it('allows zero-cost requests without requiring a balance', () => {
    expect(() =>
      assertSufficientSpendableCents(
        { purchased_cents: 0, bonus_cents: 0, reserved_cents: 0 },
        0,
      ),
    ).not.toThrow();
  });

  it('counts the current request reservation as spendable during settlement', () => {
    const availableCents = calculateAvailableSpendableCents(
      { purchased_cents: 100, bonus_cents: 0, reserved_cents: 100 },
      { releasedReservedCents: 100 },
    );

    expect(availableCents).toBe(100);
  });
});
