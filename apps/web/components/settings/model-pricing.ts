const CENTS_PER_YUAN = 100;

export type OfficialModelPricingInput = {
  input_token_price_per_million_cents: number;
  output_token_price_per_million_cents: number;
};

export type OfficialModelPricePart = {
  label: string;
  yuan: string;
  cents: string;
};

export function officialModelYuanLabel(cents: number): string {
  return `软妹币 ${(cents / CENTS_PER_YUAN).toFixed(2)}`;
}

function tokenPricePart(label: string, cents: number): string {
  return `${label} ${officialModelYuanLabel(cents)} / 百万 Token`;
}

export function officialModelPriceParts(
  input: OfficialModelPricingInput,
): OfficialModelPricePart[] {
  return [
    {
      label: '输入',
      yuan: officialModelYuanLabel(
        input.input_token_price_per_million_cents,
      ),
      cents:
        input.input_token_price_per_million_cents.toLocaleString(),
    },
    {
      label: '输出',
      yuan: officialModelYuanLabel(
        input.output_token_price_per_million_cents,
      ),
      cents:
        input.output_token_price_per_million_cents.toLocaleString(),
    },
  ];
}

export function officialModelPriceLabel(
  input: OfficialModelPricingInput,
): string {
  return [
    tokenPricePart('输入', input.input_token_price_per_million_cents),
    tokenPricePart('输出', input.output_token_price_per_million_cents),
  ].join(' · ');
}
