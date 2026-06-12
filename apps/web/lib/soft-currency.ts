import type { Locale } from '@/lib/i18n';

function resolveNumberLocale(locale?: Locale): string {
  return locale === 'zh-TW' ? 'zh-TW' : locale === 'en' ? 'en' : 'zh-CN';
}

/**
 * 将内部软妹币金额格式化为统一展示文案。
 *
 * @param coins 内部软妹币金额。
 * @param locale 当前前端展示语言；缺省时保持简中旧行为。
 * @returns 用于余额和扣费标签的本地化金额文案。
 */
export function formatCoins(coins: number, locale?: Locale): string {
  const amount = Number.isFinite(coins) ? coins : 0;
  const label =
    locale === 'en' ? 'CNY' : locale === 'zh-TW' ? '軟妹幣' : '软妹币';
  return `${label} ${amount.toLocaleString(resolveNumberLocale(locale), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * 将带正负号的软妹币变动格式化为统一展示文案。
 *
 * @param coins 内部软妹币变动金额。
 * @param locale 当前前端展示语言；缺省时保持简中旧行为。
 * @returns 带符号的本地化金额文案。
 */
export function formatSignedCoins(coins: number, locale?: Locale): string {
  const sign = coins > 0 ? '+' : coins < 0 ? '-' : '';
  return `${sign}${formatCoins(Math.abs(coins), locale)}`;
}
