'use client';

import { useEffect, useState } from 'react';

import { billingApi, BillingStatus, UsageStats } from '@/features/billing/api';
import { useAuth } from '@/features/auth/hooks/use-auth';

export function useBillingSnapshot() {
  const { user } = useAuth();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    if (!user) {
      setStatus(null);
      setUsage(null);
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
    } catch {
      // keep previous snapshot
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
  }, [user]);

  return { status, usage, refreshing, refresh: load };
}
