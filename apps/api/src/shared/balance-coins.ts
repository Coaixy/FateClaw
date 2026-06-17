export const INSUFFICIENT_BALANCE_MESSAGE = '积分不足，请补充积分后继续使用';

/** 钱包可消费余额计算需要的最小字段集合。 */
export interface SpendableBalanceState {
  readonly purchased_coins: number;
  readonly bonus_coins: number;
  readonly reserved_coins: number;
}

/** 当前结算上下文对可消费余额公式的补充参数。 */
export interface SpendableBalanceOptions {
  readonly releasedReservedCoins?: number;
}

/**
 * 计算钱包当前可消费余额。
 *
 * @param state 钱包余额字段，均以软妹币 coins 表达。
 * @param options 结算当前请求时可传入本次释放的冻结余额，避免同一笔冻结被重复扣减。
 * @returns 可消费余额；历史冻结余额存在时必须扣除，最终不小于 0。
 */
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

  return Math.max(
    0,
    state.purchased_coins + state.bonus_coins - effectiveReservedCoins,
  );
}

/**
 * 计算未扣冻结余额的钱包总额。
 *
 * @param state 钱包余额字段。
 * @returns 充值余额与赠送余额之和，供需要展示总额的后台视图使用。
 */
export function calculateTotalBalanceCoins(
  state: SpendableBalanceState,
): number {
  return state.purchased_coins + state.bonus_coins;
}

/**
 * 判断钱包是否处于欠费状态。
 *
 * @param state 钱包余额字段。
 * @param options 结算当前请求时可传入本次释放的冻结余额。
 * @returns 原始可消费余额小于 0 时返回 true；与对外 available_coins 的非负展示分离。
 */
export function isSpendableBalanceInArrears(
  state: SpendableBalanceState,
  options: SpendableBalanceOptions = {},
): boolean {
  const releasedReservedCoins = Math.max(
    0,
    options.releasedReservedCoins ?? 0,
  );
  const effectiveReservedCoins = Math.max(
    0,
    state.reserved_coins - releasedReservedCoins,
  );
  return state.purchased_coins + state.bonus_coins - effectiveReservedCoins < 0;
}

/**
 * 断言钱包有足够可消费余额。
 *
 * @param state 钱包余额字段。
 * @param amountCoins 需要消费的金额；非正数不做校验。
 * @param options 结算当前请求时可传入本次释放的冻结余额。
 * @throws 余额不足时抛出面向用户的错误文案。
 */
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
