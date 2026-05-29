import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  TrendingUp,
  Wallet,
} from 'lucide-react';

import type { CreatorEarningsMonthly } from '@/features/skills/api';
import { WalletStatCard } from '@/components/settings/wallet/wallet-stat-card';
import { formatCents } from '@/lib/money';

type EarningsTotals = {
  gross: number;
  platformCut: number;
  net: number;
  withdrawn: number;
};

function formatYearMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split('-');
  return `${year}年${Number(month)}月`;
}

export function WalletEarningsPanel({
  totals,
  earningsRows,
  open,
  onToggle,
}: {
  totals: EarningsTotals;
  earningsRows: CreatorEarningsMonthly[];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <WalletStatCard
          icon={<TrendingUp size={14} className="text-primary" />}
          label="累计毛收入"
          value={formatCents(totals.gross)}
        />
        <WalletStatCard
          icon={
            <ArrowDownLeft size={14} className="text-muted" />
          }
          label="平台抽成"
          value={formatCents(totals.platformCut)}
          muted
        />
        <WalletStatCard
          icon={<Wallet size={14} className="text-primary" />}
          label="净收入"
          value={formatCents(totals.net)}
          accent
        />
        <WalletStatCard
          icon={
            <ArrowUpRight size={14} className="text-muted" />
          }
          label="已提现"
          value={formatCents(totals.withdrawn)}
        />
      </div>

      <div className="rounded-2xl border border-hairline bg-surface-card overflow-hidden">
        <button
          onClick={onToggle}
          className="w-full flex items-center justify-between px-4 py-3 text-[12px] font-medium text-muted cursor-pointer hover:bg-surface-cream-strong transition-colors"
        >
          <span>月度明细</span>
          <ChevronDown
            size={14}
            className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          />
        </button>
        {open &&
          (earningsRows.length === 0 ? (
            <div className="px-4 pb-4 text-[12px] text-muted">
              暂无收入记录。发布技能并获得订阅后，数据会显示在这里。
            </div>
          ) : (
            <div className="divide-y divide-hairline/50">
              {earningsRows.map((row) => (
                <div
                  key={row.year_month}
                  className="flex items-center justify-between px-4 py-3"
                >
                  <span className="text-[13px] font-medium">
                    {formatYearMonth(row.year_month)}
                  </span>
                  <div className="flex items-center gap-4 text-[12px] tabular-nums">
                    <span className="text-muted">
                      毛 {formatCents(row.gross_cents)}
                    </span>
                    <span className="font-bold text-primary">
                      {formatCents(row.net_cents)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ))}
      </div>
    </section>
  );
}
