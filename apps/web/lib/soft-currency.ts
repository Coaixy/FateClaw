/**
 * 将内部软妹币整数格式化为统一展示文案。
 */
export function formatCoins(coins: number): string {
  return `软妹币 ${Math.trunc(coins).toLocaleString('zh-CN')}`;
}

/**
 * 将带正负号的软妹币变动格式化为统一展示文案。
 */
export function formatSignedCoins(coins: number): string {
  const sign = coins > 0 ? '+' : coins < 0 ? '-' : '';
  return `${sign}${formatCoins(Math.abs(coins))}`;
}
