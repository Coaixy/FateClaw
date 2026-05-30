/**
 * 将内部软妹币金额格式化为统一展示文案。
 */
export function formatCoins(coins: number): string {
  const amount = Number.isFinite(coins) ? coins : 0;
  return `软妹币 ${amount.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * 将带正负号的软妹币变动格式化为统一展示文案。
 */
export function formatSignedCoins(coins: number): string {
  const sign = coins > 0 ? '+' : coins < 0 ? '-' : '';
  return `${sign}${formatCoins(Math.abs(coins))}`;
}
