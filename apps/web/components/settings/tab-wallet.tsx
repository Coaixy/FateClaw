'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ArrowDownLeft,
  ArrowUpRight,
  CreditCard,
  TrendingUp,
} from 'lucide-react';

import { useWalletOverview } from '@/features/billing/hooks/use-wallet-overview';
import { WalletBalanceCard } from '@/components/settings/wallet/wallet-balance-card';
import { WalletEarningsPanel } from '@/components/settings/wallet/wallet-earnings-panel';
import { WalletRechargePanel } from '@/components/settings/wallet/wallet-recharge-panel';
import { WalletStatCard } from '@/components/settings/wallet/wallet-stat-card';
import { WalletTokenUsagePanel } from '@/components/settings/wallet/wallet-token-usage-panel';
import { WalletTransactionsPanel } from '@/components/settings/wallet/wallet-transactions-panel';

type SubTab = 'overview' | 'usage' | 'transactions' | 'earnings';

function formatPoints(points: number): string {
  return `${points.toLocaleString()} 积分`;
}

function formatPointsWithYuan(points: number): string {
  return `${points.toLocaleString()} 积分 (≈¥${(points / 100).toFixed(2)})`;
}

export function TabWallet() {
  const {
    billingInfo,
    dailyUsage,
    transactions,
    rechargeOrders,
    rechargeStats,
    earningsRows,
    earningsTotals,
    loading,
    refreshing,
    error,
    refresh,
  } = useWalletOverview();
  const [subTab, setSubTab] = useState<SubTab>('overview');
  const [earningsOpen, setEarningsOpen] = useState(false);

  const purchasedPoints = billingInfo?.purchased_points ?? 0;
  const bonusPoints = billingInfo?.bonus_points ?? 0;
  const earnedPoints = billingInfo?.earned_points ?? 0;
  const reservedPoints = billingInfo?.reserved_points ?? 0;
  const availablePoints = billingInfo?.available_points ?? 0;

  const subTabs: { key: SubTab; label: string }[] = [
    { key: 'overview', label: '概览' },
    { key: 'usage', label: 'Token 明细' },
    { key: 'transactions', label: '流水' },
    { key: 'earnings', label: '创作收益' },
  ];

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-[140px] rounded-2xl border border-hairline bg-surface-card animate-pulse" />
        <div className="h-[200px] rounded-2xl border border-hairline bg-surface-card animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <WalletBalanceCard
        availablePoints={availablePoints}
        purchasedPoints={purchasedPoints}
        bonusPoints={bonusPoints}
        earnedPoints={earnedPoints}
        reservedPoints={reservedPoints}
      />

      <WalletRechargePanel
        orders={rechargeOrders}
        stats={rechargeStats}
        refreshing={refreshing}
        onChanged={refresh}
      />

      {error && (
        <div className="rounded-xl border border-error/30 bg-error/8 px-4 py-3 text-[12px] text-error">
          {error}
        </div>
      )}

      <div className="grid gap-3">
        <Link
          href="/settings/withdrawal"
          className={`h-12 rounded-xl border border-hairline bg-surface-card text-[13px] font-medium flex items-center justify-center gap-2 transition-colors ${
            earnedPoints > 0
              ? 'text-ink hover:bg-surface-cream-strong'
              : 'text-muted opacity-60'
          }`}
        >
          <ArrowUpRight size={16} />
          提现
          {earnedPoints > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary ml-1">
              {earnedPoints.toLocaleString()} 可提
            </span>
          )}
        </Link>
      </div>

      {/* Sub Tabs */}
      <div className="flex rounded-xl bg-surface-card border border-hairline overflow-hidden">
        {subTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setSubTab(t.key)}
            className={`flex-1 h-10 text-[12px] font-medium transition-all cursor-pointer ${
              subTab === t.key
                ? 'bg-surface-cream-strong text-ink'
                : 'text-muted hover:text-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Sub Tab content */}
      {subTab === 'overview' && (
        <section className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <WalletStatCard
              icon={
                <CreditCard size={14} className="text-primary" />
              }
              label="本月 Token"
              value={(billingInfo?.monthly_tokens_used ?? 0).toLocaleString()}
            />
            <WalletStatCard
              icon={
                <TrendingUp size={14} className="text-primary" />
              }
              label="本月消耗"
              value={formatPointsWithYuan(
                billingInfo?.estimated_monthly_total_points ?? 0,
              )}
            />
            <WalletStatCard
              icon={<ArrowDownLeft size={14} className="text-purple-400" />}
              label="创作净收入"
              value={formatPoints(earningsTotals.net)}
            />
          </div>
          <p className="text-[11px] text-muted leading-relaxed px-1">
            创作收益积分可通过独立提现通道折算为人民币（100 积分 = 1
            元）。充值积分用于官方模型 Token 和技能订阅消费。
          </p>
        </section>
      )}

      {subTab === 'usage' && (
        <WalletTokenUsagePanel dailyUsage={dailyUsage} />
      )}

      {subTab === 'transactions' && (
        <WalletTransactionsPanel transactions={transactions} />
      )}

      {subTab === 'earnings' && (
        <WalletEarningsPanel
          totals={earningsTotals}
          earningsRows={earningsRows}
          open={earningsOpen}
          onToggle={() => setEarningsOpen(!earningsOpen)}
        />
      )}
    </div>
  );
}
