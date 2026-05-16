'use client';

import { useEffect, useState } from 'react';

import { billingApi, BillingStatus, UsageStats } from '@/features/billing/api';
import { useAuth } from '@/features/auth/hooks/use-auth';

let statusCache: { at: number; data: BillingStatus } | null = null;
let usageCache: { at: number; data: UsageStats } | null = null;

const CACHE_TTL = 60_000;

export function useBillingSnapshot() {
  const { user } = useAuth();
  const [status, setStatus] = useState<BillingStatus | null>(
    statusCache?.data ?? null,
  );
  const [usage, setUsage] = useState<UsageStats | null>(
    usageCache?.data ?? null,
  );
  const [refreshing, setRefreshing] = useState(false);

  const load = async (force = false) => {
    if (!user) {
      setStatus(null);
      setUsage(null);
      return;
    }

    const now = Date.now();
    const statusFresh = statusCache && now - statusCache.at < CACHE_TTL;
    const usageFresh = usageCache && now - usageCache.at < CACHE_TTL;

    if (!force && statusFresh && usageFresh) {
      setStatus(statusCache!.data);
      setUsage(usageCache!.data);
      return;
    }

    setRefreshing(true);

    try {
      const [nextStatus, nextUsage] = await Promise.all([
        !force && statusFresh
          ? Promise.resolve(statusCache!.data)
          : billingApi.status(),
        !force && usageFresh
          ? Promise.resolve(usageCache!.data)
          : billingApi.usage(),
      ]);

      statusCache = { at: Date.now(), data: nextStatus };
      usageCache = { at: Date.now(), data: nextUsage };
      setStatus(nextStatus);
      setUsage(nextUsage);
    } catch {
      // keep previous snapshot
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
  }, [user]);

  return { status, usage, refreshing, refresh: () => load(true) };
}
