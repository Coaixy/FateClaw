import { formatCoins } from '../../lib/soft-currency';

export const DEFAULT_CUSTOM_MODEL_PLATFORM_PRICE_PER_MILLION_COINS = 2;

export type OfficialModelPricingInput = {
  input_token_price_per_million_coins: number;
  output_token_price_per_million_coins: number;
};

export type OfficialModelPricePart = {
  label: string;
  coins: string;
};

/**
 * 将模型计费单价格式化为和钱包一致的软妹币整数展示。
 */
export function officialModelCoinsLabel(coins: number): string {
  return formatCoins(coins);
}

function tokenPricePart(label: string, coins: number): string {
  return `${label} ${officialModelCoinsLabel(coins)} / 百万 Token`;
}

export function officialModelPriceParts(
  input: OfficialModelPricingInput,
): OfficialModelPricePart[] {
  return [
    {
      label: '输入',
      coins: officialModelCoinsLabel(
        input.input_token_price_per_million_coins,
      ),
    },
    {
      label: '输出',
      coins: officialModelCoinsLabel(
        input.output_token_price_per_million_coins,
      ),
    },
  ];
}

export function officialModelPriceLabel(
  input: OfficialModelPricingInput,
): string {
  return [
    tokenPricePart('输入', input.input_token_price_per_million_coins),
    tokenPricePart('输出', input.output_token_price_per_million_coins),
  ].join(' · ');
}

/**
 * 返回自配模型平台服务费的金额展示。
 */
export function customModelPlatformFeeAmountLabel(coins: number): string {
  return officialModelCoinsLabel(coins);
}

/**
 * 返回自配模型平台服务费的完整标签。
 */
export function customModelPlatformFeeLabel(coins: number): string {
  return `平台 Token 服务费 ${customModelPlatformFeeAmountLabel(coins)} / 百万 Token`;
}
