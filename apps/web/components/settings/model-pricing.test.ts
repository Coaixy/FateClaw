import { describe, expect, it } from 'vitest';

import { officialModelPriceLabel } from './model-pricing';

describe('officialModelPriceLabel', () => {
  it('shows yuan equivalents alongside point prices', () => {
    expect(
      officialModelPriceLabel({
        input_token_price_per_million_points: 1000,
        output_token_price_per_million_points: 5000,
      }),
    ).toBe(
      '输入 ¥10.00 / 百万 Token（1,000 积分） · 输出 ¥50.00 / 百万 Token（5,000 积分）',
    );
  });
});
