import { describe, expect, it } from 'vitest';

import { officialModelPriceParts } from '../../../components/settings/model-pricing';

describe('officialModelPriceParts', () => {
  it('shows distinct input and output credit prices', () => {
    expect(
      officialModelPriceParts({
        input_token_price_per_million_coins: 1000,
        output_token_price_per_million_coins: 5000,
      }),
    ).toEqual([
      { label: '输入', coins: '1,000.00 积分' },
      { label: '输出', coins: '5,000.00 积分' },
    ]);
  });
});
