'use client';

import { useState } from 'react';
import {
  ArrowDownLeft,
  CreditCard,
  TrendingUp,
} from 'lucide-react';

import { useWalletOverview } from '@/features/billing/hooks/use-wallet-overview';
import { formatCents } from '@/lib/money';
import { WalletBalanceCard } from '@/components/settings/wallet/wallet-balance-card';
import { WalletRechargePanel } from '@/components/settings/wallet/wallet-recharge-panel';
import { WalletStatCard } from '@/components/settings/wallet/wallet-stat-card';
import { WalletTokenUsagePanel } from '@/components/settings/wallet/wallet-token-usage-panel';
import { WalletTransactionsPanel } from '@/components/settings/wallet/wallet-transactions-panel';

type SubTab = 'overview' | 'usage' | 'transactions';

export function TabWallet() {
  const {
    billingInfo,
    dailyUsage,
    transactions,
    rechargeOrders,
    rechargeStats,
    loading,
    refreshing,
    error,
    refresh,
  } = useWalletOverview();
  const [subTab, setSubTab] = useState<SubTab>('overview');

  const purchasedCents = billingInfo?.purchased_cents ?? 0;
  const bonusCents = billingInfo?.bonus_cents ?? 0;
  const reservedCents = billingInfo?.reserved_cents ?? 0;
  const availableCents = billingInfo?.available_cents ?? 0;

  const subTabs: { key: SubTab; label: string }[] = [
    { key: 'overview', label: '概览' },
    { key: 'usage', label: 'Token 明细' },
    { key: 'transactions', label: '流水' },
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
        availableCents={availableCents}
        purchasedCents={purchasedCents}
        bonusCents={bonusCents}
        reservedCents={reservedCents}
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
              value={formatCents(
                billingInfo?.estimated_monthly_total_cents ?? 0,
              )}
            />
            <WalletStatCard
              icon={<ArrowDownLeft size={14} className="text-purple-400" />}
              label="充值累计"
              value={formatCents(rechargeStats?.total_recharge_cents ?? 0)}
            />
          </div>
          <p className="text-[11px] text-muted leading-relaxed px-1">
            充值余额用于官方模型、自配模型平台 Token 服务费和技能订阅消费。
          </p>
        </section>
      )}

      {subTab === 'usage' && (
        <WalletTokenUsagePanel dailyUsage={dailyUsage} />
      )}

      {subTab === 'transactions' && (
        <WalletTransactionsPanel transactions={transactions} />
      )}
    </div>
  );
}
