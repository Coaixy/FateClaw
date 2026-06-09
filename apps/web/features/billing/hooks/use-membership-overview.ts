'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  billingApi,
  type BillingStatus,
  type DailyUsageRow,
  type UsageStats,
} from '@/features/billing/api';

async function fetchMembershipOverviewSnapshot() {
  return Promise.all([
    billingApi.status(),
    billingApi.usage(),
    billingApi.dailyUsage(),
  ]);
}

/**
 * 会员中心数据 Hook。
 *
 * @returns 会员订阅状态、汇总用量、每日 Token 明细、加载态和刷新函数。
 */
export function useMembershipOverview() {
  const [billingInfo, setBillingInfo] = useState<BillingStatus | null>(null);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [dailyUsage, setDailyUsage] = useState<DailyUsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    setRefreshing(true);
    setError(null);

    try {
      const [nextBilling, nextUsage, nextDailyUsage] =
        await fetchMembershipOverviewSnapshot();
      setBillingInfo(nextBilling);
      setUsage(nextUsage);
      setDailyUsage(nextDailyUsage);
    } catch (err) {
      setError(err instanceof Error ? err.message : '会员中心数据加载失败');
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
        const [nextBilling, nextUsage, nextDailyUsage] =
          await fetchMembershipOverviewSnapshot();
        if (cancelled) return;
        setBillingInfo(nextBilling);
        setUsage(nextUsage);
        setDailyUsage(nextDailyUsage);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '会员中心数据加载失败');
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
    usage,
    dailyUsage,
    loading,
    refreshing,
    error,
    refresh: () => load(false),
  };
}
