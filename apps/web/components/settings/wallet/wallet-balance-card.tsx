import { formatCoins } from '@/lib/soft-currency';

type WalletBalanceCardProps = {
  availableCoins: number;
  purchasedCoins: number;
  bonusCoins: number;
  reservedCoins: number;
};

export function WalletBalanceCard({
  availableCoins,
  purchasedCoins,
  bonusCoins,
  reservedCoins,
}: WalletBalanceCardProps) {
  return (
    <section className="rounded-2xl border border-hairline bg-surface-card p-5 relative overflow-hidden">
      <div className="absolute top-0 right-0 w-40 h-40 bg-[radial-gradient(circle_at_top_right,color-mix(in_srgb,var(--color-primary)_8%,transparent),transparent_70%)] pointer-events-none" />
      <div className="relative z-10">
        <div className="text-[11px] font-medium text-muted uppercase tracking-wider mb-1">
          可用余额
        </div>
        <div className="text-3xl font-extrabold tracking-tight mb-1">
          {formatCoins(availableCoins)}
        </div>
        <div className="text-[11px] text-muted mb-4">
          金额按软妹币余额展示
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <WalletBalanceItem label="充值余额" value={formatCoins(purchasedCoins)} />
          <WalletBalanceItem
            label="赠送余额"
            value={formatCoins(bonusCoins)}
            valueClassName="text-primary"
          />
          <WalletBalanceItem
            label="冻结中"
            value={formatCoins(reservedCoins)}
            valueClassName="text-muted"
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
