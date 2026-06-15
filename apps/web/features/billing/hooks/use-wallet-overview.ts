'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  billingApi,
  type BillingStatus,
  type RechargeOrder,
  type RechargeStats,
  type WalletTransaction,
} from '@/features/billing/api';

async function fetchWalletOverviewSnapshot() {
  return Promise.all([
    billingApi.status(),
    billingApi.transactions(),
    billingApi.rechargeOrders(),
    billingApi.rechargeStats(),
  ]);
}

/**
 * 积分与账单概览数据 Hook。
 *
 * 只聚合积分余额、补充积分订单和流水；会员订阅与 Token 用量由会员中心承载。
 */
export function useWalletOverview() {
  const [billingInfo, setBillingInfo] = useState<BillingStatus | null>(null);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [rechargeOrders, setRechargeOrders] = useState<RechargeOrder[]>([]);
  const [rechargeStats, setRechargeStats] = useState<RechargeStats | null>(
    null,
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
        nextTransactions,
        nextRechargeOrders,
        nextRechargeStats,
      ] = await fetchWalletOverviewSnapshot();
      setBillingInfo(nextBilling);
      setTransactions(nextTransactions);
      setRechargeOrders(nextRechargeOrders);
      setRechargeStats(nextRechargeStats);
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
          nextTransactions,
          nextRechargeOrders,
          nextRechargeStats,
        ] = await fetchWalletOverviewSnapshot();
        if (cancelled) return;
        setBillingInfo(nextBilling);
        setTransactions(nextTransactions);
        setRechargeOrders(nextRechargeOrders);
        setRechargeStats(nextRechargeStats);
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

  return {
    billingInfo,
    transactions,
    rechargeOrders,
    rechargeStats,
    loading,
    refreshing,
    error,
    refresh: () => load(false),
  };
}
