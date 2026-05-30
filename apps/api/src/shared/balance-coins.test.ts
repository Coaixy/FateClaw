import { describe, expect, it } from 'vitest';

import {
  INSUFFICIENT_BALANCE_MESSAGE,
  assertSufficientSpendableCoins,
  calculateAvailableSpendableCoins,
} from './balance-coins.js';

describe('balance coins guards', () => {
  it('blocks positive reservations when no spendable balance is available', () => {
    expect(() =>
      assertSufficientSpendableCoins(
        { purchased_coins: 0, bonus_coins: 0, reserved_coins: 0 },
        1,
      ),
    ).toThrow(INSUFFICIENT_BALANCE_MESSAGE);
  });

  it('allows zero-cost requests without requiring a balance', () => {
    expect(() =>
      assertSufficientSpendableCoins(
        { purchased_coins: 0, bonus_coins: 0, reserved_coins: 0 },
        0,
      ),
    ).not.toThrow();
  });

  it('counts the current request reservation as spendable during settlement', () => {
    const availableCoins = calculateAvailableSpendableCoins(
      { purchased_coins: 100, bonus_coins: 0, reserved_coins: 100 },
      { releasedReservedCoins: 100 },
    );

    expect(availableCoins).toBe(100);
  });

  it('returns negative spendable balance for arrears', () => {
    expect(
      calculateAvailableSpendableCoins({
        purchased_coins: -3,
        bonus_coins: 0,
        reserved_coins: 0,
      }),
    ).toBe(-3);
  });
});
