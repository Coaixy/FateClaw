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
 * 将模型计费单价格式化为和钱包一致的软妹币展示。
 */
export function officialModelCoinsLabel(coins: number): string {
  return formatCoins(coins);
}

function tokenPricePart(label: string, coins: number): string {
  return `${label} ${officialModelCoinsLabel(coins)} / 百万 Token`;
}

function officialModelTotalPriceCoins(
  input: OfficialModelPricingInput,
): number {
  return (
    input.input_token_price_per_million_coins +
    input.output_token_price_per_million_coins
  );
}

/**
 * 从可用官方模型里选出默认模型。
 *
 * @param models 官方模型候选列表；同价时保留列表中更靠前的模型。
 * @returns 输入和输出 Token 总单价最低的可用模型；没有可用模型时返回 null。
 * @remarks 只选择已启用且已配置密钥的模型，避免默认到无法调用的官方模型。
 */
export function findLowestPricedOfficialModel<
  T extends OfficialModelPricingInput & {
    enabled: boolean;
    has_secret: boolean;
  },
>(models: readonly T[]): T | null {
  return models.reduce<T | null>((lowest, model) => {
    if (!model.enabled || !model.has_secret) {
      return lowest;
    }
    if (!lowest) {
      return model;
    }
    return officialModelTotalPriceCoins(model) <
      officialModelTotalPriceCoins(lowest)
      ? model
      : lowest;
  }, null);
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
