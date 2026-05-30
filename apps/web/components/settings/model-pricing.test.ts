import { describe, expect, it } from 'vitest';

import {
  customModelPlatformFeeLabel,
  findLowestPricedOfficialModel,
  officialModelPriceLabel,
} from './model-pricing';

describe('officialModelPriceLabel', () => {
  it('shows soft currency token prices', () => {
    expect(
      officialModelPriceLabel({
        input_token_price_per_million_coins: 1000,
        output_token_price_per_million_coins: 5000,
      }),
    ).toBe(
      '输入 软妹币 1,000.00 / 百万 Token · 输出 软妹币 5,000.00 / 百万 Token',
    );
  });
});

describe('customModelPlatformFeeLabel', () => {
  it('shows the platform service fee for custom models', () => {
    expect(customModelPlatformFeeLabel(2)).toBe(
      '平台 Token 服务费 软妹币 2.00 / 百万 Token',
    );
  });
});

describe('findLowestPricedOfficialModel', () => {
  it('chooses the enabled model with a secret and the lowest total token price', () => {
    const models = [
      officialModel({
        id: 'disabled-cheap',
        enabled: false,
        input_token_price_per_million_coins: 1,
        output_token_price_per_million_coins: 1,
      }),
      officialModel({
        id: 'missing-secret-cheap',
        has_secret: false,
        input_token_price_per_million_coins: 1,
        output_token_price_per_million_coins: 1,
      }),
      officialModel({
        id: 'expensive',
        input_token_price_per_million_coins: 10,
        output_token_price_per_million_coins: 20,
      }),
      officialModel({
        id: 'cheapest',
        input_token_price_per_million_coins: 5,
        output_token_price_per_million_coins: 6,
      }),
    ];

    expect(findLowestPricedOfficialModel(models)?.id).toBe('cheapest');
  });

  it('keeps the earlier model when total prices are equal', () => {
    const models = [
      officialModel({
        id: 'first',
        input_token_price_per_million_coins: 4,
        output_token_price_per_million_coins: 8,
      }),
      officialModel({
        id: 'second',
        input_token_price_per_million_coins: 6,
        output_token_price_per_million_coins: 6,
      }),
    ];

    expect(findLowestPricedOfficialModel(models)?.id).toBe('first');
  });

  it('returns null when no official model can be used', () => {
    const models = [
      officialModel({ id: 'disabled', enabled: false }),
      officialModel({ id: 'missing-secret', has_secret: false }),
    ];

    expect(findLowestPricedOfficialModel(models)).toBeNull();
  });
});

function officialModel(
  overrides: Partial<{
    id: string;
    enabled: boolean;
    has_secret: boolean;
    input_token_price_per_million_coins: number;
    output_token_price_per_million_coins: number;
  }> = {},
) {
  return {
    id: 'model',
    enabled: true,
    has_secret: true,
    input_token_price_per_million_coins: 100,
    output_token_price_per_million_coins: 100,
    ...overrides,
  };
}
