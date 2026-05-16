export function WalletStatCard({
  icon,
  label,
  value,
  accent,
  muted,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-3.5 ${
        accent
          ? 'border-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-primary)_6%,transparent)]'
          : 'border-hairline bg-surface-card'
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        {icon}
        <span className="text-[10px] font-medium text-muted uppercase tracking-wider">
          {label}
        </span>
      </div>
      <div
        className={`text-lg font-bold tracking-tight tabular-nums ${
          accent ? 'text-primary' : muted ? 'text-muted' : ''
        }`}
      >
        {value}
      </div>
    </div>
  );
}
