'use client';

import { useCallback, useEffect, useState } from 'react';

import { billingApi, BillingStatus, UsageStats } from '@/features/billing/api';
import { useAuth } from '@/features/auth/hooks/use-auth';

/**
 * 读取当前登录用户的账单快照。
 *
 * @returns 余额、用量、初始加载态、刷新态和手动刷新函数。
 * @remarks 接口失败时会结束初始加载态并保留已有快照，避免界面一直显示骨架。
 */
export function useBillingSnapshot() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) {
      setStatus(null);
      setUsage(null);
      setLoadedUserId(null);
      return;
    }

    setRefreshing(true);

    try {
      const [nextStatus, nextUsage] = await Promise.all([
        billingApi.status(),
        billingApi.usage(),
      ]);

      setStatus(nextStatus);
      setUsage(nextUsage);
      setLoadedUserId(userId);
    } catch {
      // 账单接口失败时结束初始骨架，保留旧快照或空态，避免界面一直加载。
      setLoadedUserId(userId);
    } finally {
      setRefreshing(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    status,
    usage,
    loading: Boolean(userId) && loadedUserId !== userId,
    refreshing,
    refresh: load,
  };
}
