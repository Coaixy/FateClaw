'use client';

import { useCallback, useEffect, useState } from 'react';

import { accountsApi, type Account } from '@/features/accounts/api';
import { useAuth } from '@/features/auth/hooks/use-auth';

export function useAccounts() {
  const { user } = useAuth();
  const [accountList, setAccountList] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) {
      setAccountList([]);
      setLoadError(null);
      setLoading(false);
      return false;
    }

    try {
      const nextAccounts = await accountsApi.list();
      setAccountList(nextAccounts);
      setLoadError(null);
      return true;
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : '加载设备信息失败，请稍后重试',
      );
      return false;
    } finally {
      setLoading(false);
    }
  }, [user]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  return { accountList, loading, refreshing, loadError, load, refresh };
}
