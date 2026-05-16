type WalletBalanceCardProps = {
  availablePoints: number;
  purchasedPoints: number;
  bonusPoints: number;
  earnedPoints: number;
  reservedPoints: number;
};

export function WalletBalanceCard({
  availablePoints,
  purchasedPoints,
  bonusPoints,
  earnedPoints,
  reservedPoints,
}: WalletBalanceCardProps) {
  return (
    <section className="rounded-2xl border border-hairline bg-surface-card p-5 relative overflow-hidden">
      <div className="absolute top-0 right-0 w-40 h-40 bg-[radial-gradient(circle_at_top_right,color-mix(in_srgb,var(--color-primary)_8%,transparent),transparent_70%)] pointer-events-none" />
      <div className="relative z-10">
        <div className="text-[11px] font-medium text-muted uppercase tracking-wider mb-1">
          可用积分
        </div>
        <div className="text-3xl font-extrabold tracking-tight mb-1">
          {availablePoints.toLocaleString()} 积分
        </div>
        <div className="text-[11px] text-muted mb-4">
          ≈ ¥{(availablePoints / 100).toFixed(2)}（100 积分 = 1 元）
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <WalletBalanceItem label="充值积分" value={purchasedPoints.toLocaleString()} />
          <WalletBalanceItem
            label="赠送积分"
            value={bonusPoints.toLocaleString()}
            valueClassName="text-primary"
          />
          <WalletBalanceItem
            label="冻结中"
            value={reservedPoints.toLocaleString()}
            valueClassName="text-muted"
          />
          {earnedPoints > 0 && (
            <WalletBalanceItem
              label="创作收益"
              value={earnedPoints.toLocaleString()}
              valueClassName="text-primary"
            />
          )}
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
