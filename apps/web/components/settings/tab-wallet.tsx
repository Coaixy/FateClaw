'use client';

import { useState } from 'react';
import {
  ArrowDownLeft,
  CreditCard,
  TrendingUp,
} from 'lucide-react';

import { billingApi } from '@/features/billing/api';
import { useWalletOverview } from '@/features/billing/hooks/use-wallet-overview';
import { useConfirm } from '@/lib/use-confirm';
import { formatCoins } from '@/lib/soft-currency';
import { WalletBalanceCard } from '@/components/settings/wallet/wallet-balance-card';
import { WalletMembershipCard } from '@/components/settings/wallet/wallet-membership-card';
import { WalletRechargePanel } from '@/components/settings/wallet/wallet-recharge-panel';
import { WalletStatCard } from '@/components/settings/wallet/wallet-stat-card';
import { WalletTokenUsagePanel } from '@/components/settings/wallet/wallet-token-usage-panel';
import { WalletTransactionsPanel } from '@/components/settings/wallet/wallet-transactions-panel';

type SubTab = 'overview' | 'usage' | 'transactions';

export function TabWallet() {
  const { confirm } = useConfirm();
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
  const [membershipBusy, setMembershipBusy] = useState(false);
  const [membershipError, setMembershipError] = useState<string | null>(null);

  const purchasedCoins = billingInfo?.purchased_coins ?? 0;
  const bonusCoins = billingInfo?.bonus_coins ?? 0;
  const availableCoins = billingInfo?.available_coins ?? 0;

  const subTabs: { key: SubTab; label: string }[] = [
    { key: 'overview', label: '概览' },
    { key: 'usage', label: 'Token 明细' },
    { key: 'transactions', label: '流水' },
  ];

  const handleSubscribeMembership = async () => {
    const membership = billingInfo?.membership;
    if (!membership || membershipBusy || !membership.enabled) return;

    const priceText = formatCoins(membership.monthly_price_coins);
    const ok = await confirm({
      title: membership.active ? '确认续费会员' : '确认开通会员',
      message: membership.active
        ? `将从钱包余额扣除 ${priceText}，会员有效期将在当前周期结束后顺延 1 个月。`
        : `将从钱包余额扣除 ${priceText}，开通 FateClaw Plus 会员 1 个月。`,
      confirmLabel: membership.active ? '确认续费' : '确认开通',
      cancelLabel: '取消',
    });
    if (!ok) return;

    setMembershipBusy(true);
    setMembershipError(null);
    try {
      await billingApi.subscribeMembership();
      await refresh();
    } catch (err) {
      setMembershipError(
        err instanceof Error ? err.message : '开通会员失败',
      );
    } finally {
      setMembershipBusy(false);
    }
  };

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
        availableCoins={availableCoins}
        purchasedCoins={purchasedCoins}
        bonusCoins={bonusCoins}
      />

      {billingInfo?.membership && (
        <WalletMembershipCard
          membership={billingInfo.membership}
          busy={membershipBusy}
          onSubscribe={() => void handleSubscribeMembership()}
        />
      )}

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
      {membershipError && (
        <div className="rounded-xl border border-error/30 bg-error/8 px-4 py-3 text-[12px] text-error">
          {membershipError}
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
              value={formatCoins(
                billingInfo?.estimated_monthly_total_coins ?? 0,
              )}
            />
            <WalletStatCard
              icon={<ArrowDownLeft size={14} className="text-purple-400" />}
              label="充值累计"
              value={formatCoins(rechargeStats?.total_recharge_coins ?? 0)}
            />
          </div>
          <p className="text-[11px] text-muted leading-relaxed px-1">
            充值余额用于官方模型和自配模型平台 Token 服务费。
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
