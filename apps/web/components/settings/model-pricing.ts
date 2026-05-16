const POINTS_PER_YUAN = 100;

function yuanLabel(points: number): string {
  return `¥${(points / POINTS_PER_YUAN).toFixed(2)}`;
}

function tokenPricePart(label: string, points: number): string {
  return `${label} ${yuanLabel(points)} / 百万 Token（${points.toLocaleString()} 积分）`;
}

export function officialModelPriceLabel(input: {
  input_token_price_per_million_points: number;
  output_token_price_per_million_points: number;
}): string {
  return [
    tokenPricePart('输入', input.input_token_price_per_million_points),
    tokenPricePart('输出', input.output_token_price_per_million_points),
  ].join(' · ');
}
