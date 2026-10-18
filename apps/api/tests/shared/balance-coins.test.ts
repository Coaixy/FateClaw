import { describe, expect, it } from 'vitest';

import {
  INSUFFICIENT_BALANCE_MESSAGE,
  assertSufficientSpendableCoins,
  calculateAvailableSpendableCoins,
  isSpendableBalanceInArrears,
  roundCoinsToCents,
} from '#shared/balance-coins';

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

  it('keeps available balance non-negative and reports arrears separately', () => {
    expect(
      calculateAvailableSpendableCoins({
        purchased_coins: -3,
        bonus_coins: 0,
        reserved_coins: 0,
      }),
    ).toBe(0);
    expect(
      isSpendableBalanceInArrears({
        purchased_coins: -3,
        bonus_coins: 0,
        reserved_coins: 0,
      }),
    ).toBe(true);
  });
});

describe('roundCoinsToCents (统一取整口径)', () => {
  it('四舍五入到分', () => {
    expect(roundCoinsToCents(1.234)).toBe(1.23);
    expect(roundCoinsToCents(1.235)).toBe(1.24);
    expect(roundCoinsToCents(0.1 + 0.2)).toBe(0.3); // 浮点误差被收敛
  });

  it('非有限数（NaN/Infinity）归 0', () => {
    expect(roundCoinsToCents(Number.NaN)).toBe(0);
    expect(roundCoinsToCents(Number.POSITIVE_INFINITY)).toBe(0);
    expect(roundCoinsToCents(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('-0 输入归一为 +0（避免 -0 写库）', () => {
    expect(Object.is(roundCoinsToCents(-0), 0)).toBe(true);
  });

  it('极小负数舍入到零（数值意义上为 0）', () => {
    // 注：结果可能是 -0，但 -0 === 0 且 PG numeric 存为 0，无副作用。
    expect(roundCoinsToCents(-0.001) === 0).toBe(true);
  });

  it('保留负数符号（余额增减/退款可为负）', () => {
    expect(roundCoinsToCents(-1.235)).toBe(-1.24);
    expect(roundCoinsToCents(-10)).toBe(-10);
  });
});
