import { formatCoins } from '@/lib/soft-currency';
import { useI18n } from '@/lib/i18n';

type WalletBalanceCardProps = {
  availableCoins: number;
  purchasedCoins: number;
  bonusCoins: number;
};

export function WalletBalanceCard({
  availableCoins,
  purchasedCoins,
  bonusCoins,
}: WalletBalanceCardProps) {
  const isInArrears = availableCoins < 0;
  const { locale, t } = useI18n();

  return (
    <section className="rounded-2xl border border-hairline bg-surface-card p-5 relative overflow-hidden">
      <div className="absolute top-0 right-0 w-40 h-40 bg-[radial-gradient(circle_at_top_right,color-mix(in_srgb,var(--color-primary)_8%,transparent),transparent_70%)] pointer-events-none" />
      <div className="relative z-10">
        <div className="text-[11px] font-medium text-muted uppercase tracking-wider mb-1">
          {t('pages.wallet.availableBalance')}
        </div>
        <div className="text-3xl font-extrabold tracking-tight mb-1">
          {formatCoins(availableCoins, locale)}
        </div>
        <div className="text-[11px] text-muted mb-4">
          {isInArrears
            ? t('pages.wallet.arrearsHint')
            : t('pages.wallet.balanceHint')}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <WalletBalanceItem
            label={t('pages.wallet.purchasedBalance')}
            value={formatCoins(purchasedCoins, locale)}
          />
          <WalletBalanceItem
            label={t('pages.wallet.bonusBalance')}
            value={formatCoins(bonusCoins, locale)}
            valueClassName="text-primary"
          />
        </div>
      </div>
    </section>
  );
}

function WalletBalanceItem({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div>
      <div className="text-[10px] text-muted uppercase tracking-wider">
        {label}
      </div>
      <div className={`text-[14px] font-bold tabular-nums mt-0.5 ${valueClassName ?? ''}`}>
        {value}
      </div>
    </div>
  );
}
