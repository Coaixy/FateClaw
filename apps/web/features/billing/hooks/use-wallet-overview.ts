'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  billingApi,
  type BillingStatus,
  type DailyUsageRow,
  type RechargeOrder,
  type RechargeStats,
  type WalletTransaction,
} from '@/features/billing/api';
import { skillsApi, type CreatorEarningsMonthly } from '@/features/skills/api';

async function fetchWalletOverviewSnapshot() {
  return Promise.all([
    billingApi.status(),
    billingApi.dailyUsage(),
    billingApi.transactions(),
    billingApi.rechargeOrders(),
    billingApi.rechargeStats(),
    skillsApi.earningsMine().catch(() => []),
  ]);
}

export function useWalletOverview() {
  const [billingInfo, setBillingInfo] = useState<BillingStatus | null>(null);
  const [dailyUsage, setDailyUsage] = useState<DailyUsageRow[]>([]);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [rechargeOrders, setRechargeOrders] = useState<RechargeOrder[]>([]);
  const [rechargeStats, setRechargeStats] = useState<RechargeStats | null>(
    null,
  );
  const [earningsRows, setEarningsRows] = useState<CreatorEarningsMonthly[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    setRefreshing(true);
    setError(null);
    try {
      const [
        nextBilling,
        nextDailyUsage,
        nextTransactions,
        nextRechargeOrders,
        nextRechargeStats,
        nextEarnings,
      ] = await fetchWalletOverviewSnapshot();
      setBillingInfo(nextBilling);
      setDailyUsage(nextDailyUsage);
      setTransactions(nextTransactions);
      setRechargeOrders(nextRechargeOrders);
      setRechargeStats(nextRechargeStats);
      setEarningsRows(nextEarnings);
    } catch (err) {
      setError(err instanceof Error ? err.message : '钱包数据加载失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setRefreshing(true);
      setError(null);
      try {
        const [
          nextBilling,
          nextDailyUsage,
          nextTransactions,
          nextRechargeOrders,
          nextRechargeStats,
          nextEarnings,
        ] = await fetchWalletOverviewSnapshot();
        if (cancelled) return;
        setBillingInfo(nextBilling);
        setDailyUsage(nextDailyUsage);
        setTransactions(nextTransactions);
        setRechargeOrders(nextRechargeOrders);
        setRechargeStats(nextRechargeStats);
        setEarningsRows(nextEarnings);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '钱包数据加载失败');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const earningsTotals = useMemo(() => {
    const gross = earningsRows.reduce((sum, row) => sum + row.gross_cents, 0);
    const platformCut = earningsRows.reduce(
      (sum, row) => sum + row.platform_cut_cents,
      0,
    );
    const net = earningsRows.reduce((sum, row) => sum + row.net_cents, 0);
    const withdrawn = earningsRows.reduce(
      (sum, row) => sum + row.withdrawn_cents,
      0,
    );
    return { gross, platformCut, net, withdrawn };
  }, [earningsRows]);

  return {
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
    refresh: () => load(false),
  };
}
