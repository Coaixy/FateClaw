const POINTS_PER_YUAN = 100;

export type OfficialModelPricingInput = {
  input_token_price_per_million_points: number;
  output_token_price_per_million_points: number;
};

export type OfficialModelPricePart = {
  label: string;
  yuan: string;
  points: string;
};

export function officialModelYuanLabel(points: number): string {
  return `¥${(points / POINTS_PER_YUAN).toFixed(2)}`;
}

function tokenPricePart(label: string, points: number): string {
  return `${label} ${officialModelYuanLabel(points)} / 百万 Token（${points.toLocaleString()} 积分）`;
}

export function officialModelPriceParts(
  input: OfficialModelPricingInput,
): OfficialModelPricePart[] {
  return [
    {
      label: '输入',
      yuan: officialModelYuanLabel(
        input.input_token_price_per_million_points,
      ),
      points:
        input.input_token_price_per_million_points.toLocaleString(),
    },
    {
      label: '输出',
      yuan: officialModelYuanLabel(
        input.output_token_price_per_million_points,
      ),
      points:
        input.output_token_price_per_million_points.toLocaleString(),
    },
  ];
}

export function officialModelPriceLabel(
  input: OfficialModelPricingInput,
): string {
  return [
    tokenPricePart('输入', input.input_token_price_per_million_points),
    tokenPricePart('输出', input.output_token_price_per_million_points),
  ].join(' · ');
}
