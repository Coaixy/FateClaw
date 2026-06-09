'use client';

import { useWalletOverview } from '@/features/billing/hooks/use-wallet-overview';
import { WalletBalanceCard } from '@/components/settings/wallet/wallet-balance-card';
import { WalletRechargePanel } from '@/components/settings/wallet/wallet-recharge-panel';
import { WalletTransactionsPanel } from '@/components/settings/wallet/wallet-transactions-panel';

/**
 * 渲染钱包页内容。
 *
 * @returns 只包含余额、充值和钱包流水的钱包视图；会员订阅与 Token 用量已拆到会员中心。
 */
export function TabWallet() {
  const {
    billingInfo,
    transactions,
    rechargeOrders,
    rechargeStats,
    loading,
    refreshing,
    error,
    refresh,
  } = useWalletOverview();

  const purchasedCoins = billingInfo?.purchased_coins ?? 0;
  const bonusCoins = billingInfo?.bonus_coins ?? 0;
  const availableCoins = billingInfo?.available_coins ?? 0;

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

      <WalletTransactionsPanel transactions={transactions} />
    </div>
  );
}
