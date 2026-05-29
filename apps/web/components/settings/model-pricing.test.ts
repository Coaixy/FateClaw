import { describe, expect, it } from 'vitest';

import { officialModelPriceLabel } from './model-pricing';

describe('officialModelPriceLabel', () => {
  it('shows soft currency token prices', () => {
    expect(
      officialModelPriceLabel({
        input_token_price_per_million_cents: 1000,
        output_token_price_per_million_cents: 5000,
      }),
    ).toBe(
      '输入 软妹币 10.00 / 百万 Token · 输出 软妹币 50.00 / 百万 Token',
    );
  });
});
