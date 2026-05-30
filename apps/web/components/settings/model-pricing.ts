export const CUSTOM_MODEL_PLATFORM_PRICE_PER_MILLION_COINS = 200;

export type OfficialModelPricingInput = {
  input_token_price_per_million_coins: number;
  output_token_price_per_million_coins: number;
};

export type OfficialModelPricePart = {
  label: string;
  coins: string;
};

export function officialModelCoinsLabel(coins: number): string {
  return `软妹币 ${Math.trunc(coins).toLocaleString('zh-CN')}`;
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

export function customModelPlatformFeeLabel(): string {
  return `平台 Token 服务费 ${officialModelCoinsLabel(CUSTOM_MODEL_PLATFORM_PRICE_PER_MILLION_COINS)} / 百万 Token`;
}
