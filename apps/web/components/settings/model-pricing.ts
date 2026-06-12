import { formatCoins } from '../../lib/soft-currency';
import type { Locale } from '@/lib/i18n';

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
export function officialModelCoinsLabel(
  coins: number,
  locale?: Locale,
): string {
  return formatCoins(coins, locale);
}

function tokenPricePart(
  label: string,
  coins: number,
  perMillionTokenLabel: string,
  locale?: Locale,
): string {
  return `${label} ${officialModelCoinsLabel(coins, locale)} / ${perMillionTokenLabel}`;
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

export function officialModelPriceLabel(
  input: OfficialModelPricingInput,
  locale?: Locale,
  t?: (key: string) => string,
): string {
  const inputLabel = t?.('pages.modelSettings.inputToken') ?? '输入';
  const outputLabel = t?.('pages.modelSettings.outputToken') ?? '输出';
  const perMillionTokenLabel =
    t?.('pages.modelSettings.perMillionToken') ?? '百万 Token';
  return [
    tokenPricePart(
      inputLabel,
      input.input_token_price_per_million_coins,
      perMillionTokenLabel,
      locale,
    ),
    tokenPricePart(
      outputLabel,
      input.output_token_price_per_million_coins,
      perMillionTokenLabel,
      locale,
    ),
  ].join(' · ');
}

/**
 * 返回自配模型平台服务费的金额展示。
 */
export function customModelPlatformFeeAmountLabel(
  coins: number,
  locale?: Locale,
): string {
  return officialModelCoinsLabel(coins, locale);
}

/**
 * 返回自配模型平台服务费的完整标签。
 */
export function customModelPlatformFeeLabel(
  coins: number,
  locale?: Locale,
  t?: (key: string, params?: Record<string, string | number>) => string,
): string {
  const fee = customModelPlatformFeeAmountLabel(coins, locale);
  return (
    t?.('pages.modelSettings.customFeeLabel', { fee }) ??
    `平台 Token 服务费 ${fee} / 百万 Token`
  );
}
