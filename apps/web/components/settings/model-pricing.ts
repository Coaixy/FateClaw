import { formatCoins } from '../../lib/soft-currency';
import type { Locale } from '@/lib/i18n';

export type OfficialModelPricingInput = {
  input_token_price_per_million_coins: number;
  output_token_price_per_million_coins: number;
};

export type OfficialModelPricePart = {
  label: string;
  coins: string;
};

/**
 * 将模型计费单价格式化为和积分余额一致的展示。
 */
export function officialModelCoinsLabel(
  coins: number,
  locale?: Locale,
): string {
  return formatCoins(coins, locale);
}

export function officialModelPriceParts(
  input: OfficialModelPricingInput,
  locale?: Locale,
  t?: (key: string) => string,
): OfficialModelPricePart[] {
  return [
    {
      label: t?.('pages.modelSettings.inputToken') ?? '输入',
      coins: officialModelCoinsLabel(
        input.input_token_price_per_million_coins,
        locale,
      ),
    },
    {
      label: t?.('pages.modelSettings.outputToken') ?? '输出',
      coins: officialModelCoinsLabel(
        input.output_token_price_per_million_coins,
        locale,
      ),
    },
  ];
}
