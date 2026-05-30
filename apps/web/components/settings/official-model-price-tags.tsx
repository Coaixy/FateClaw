import { officialModelPriceParts } from './model-pricing';

type OfficialModelPriceTagsProps = {
  model: {
    input_token_price_per_million_coins: number;
    output_token_price_per_million_coins: number;
  };
  compact?: boolean;
};

export function OfficialModelPriceTags({
  model,
  compact = false,
}: OfficialModelPriceTagsProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {officialModelPriceParts(model).map((part) => (
        <span
          key={part.label}
          className={`inline-flex min-h-7 items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 font-medium text-primary ${
            compact ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-[11px]'
          }`}
        >
          <span>{part.label}</span>
          <span className="tabular-nums">{part.coins}</span>
          <span className="text-primary/70">
            / 百万 Token
          </span>
        </span>
      ))}
    </div>
  );
}
