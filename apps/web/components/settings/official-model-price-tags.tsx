import { officialModelPriceParts } from './model-pricing';
import { useI18n } from '@/lib/i18n';

type OfficialModelPriceTagsProps = {
  model: {
    input_token_price_per_million_coins: number;
    output_token_price_per_million_coins: number;
  };
};

export function OfficialModelPriceTags({ model }: OfficialModelPriceTagsProps) {
  const { locale, t } = useI18n();

  return (
    <span className="mt-auto grid w-full gap-1 text-xs leading-5">
      {officialModelPriceParts(model, locale, t).map((part) => (
        <span
          key={part.label}
          className="flex flex-wrap justify-between gap-x-1"
        >
          <span className="text-muted">{part.label}</span>
          <span className="tabular-nums text-ink">{part.coins}</span>
        </span>
      ))}
      <span className="text-[10px] text-muted">
        / {t('pages.modelSettings.perMillionToken')}
      </span>
    </span>
  );
}
