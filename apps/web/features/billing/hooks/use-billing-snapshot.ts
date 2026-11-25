'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  BILLING_CHANGED_EVENT,
  billingApi,
  type BillingStatus,
} from '@/features/billing/api';
import { useAuth } from '@/features/auth/hooks/use-auth';
import {
  getAuthTokenSnapshot,
  isAuthTokenSnapshotCurrent,
} from '@/lib/auth-scoped-cache';

interface SnapshotState {
  userId: string | null;
  token: string | null;
  status: BillingStatus | null;
  settled: boolean;
  refreshing: boolean;
}

/**
 * 读取当前登录用户的账单快照。
 *
 * @returns 积分余额、初始加载态、刷新态和手动刷新函数。
 * @remarks 接口失败时会结束初始加载态并保留已有快照，避免界面一直显示骨架。
 */
export function useBillingSnapshot() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const token = getAuthTokenSnapshot();
  const initialSnapshot = userId ? billingApi.readStatusSnapshot() : undefined;
  const [snapshot, setSnapshot] = useState<SnapshotState>(() => ({
    userId,
    token,
    status: initialSnapshot ?? null,
    settled: initialSnapshot !== undefined,
    refreshing: false,
  }));
  const latestRequest = useRef(0);

  const load = useCallback(
    async (refresh: boolean) => {
      if (!userId || !isAuthTokenSnapshotCurrent(token)) return;

      const request = ++latestRequest.current;
      const cached = billingApi.readStatusSnapshot();
      setSnapshot((previous) => {
        const sameScope = previous.userId === userId && previous.token === token;
        return {
          userId,
          token,
          status: sameScope ? previous.status : cached ?? null,
          settled: sameScope ? previous.settled : cached !== undefined,
          refreshing: refresh || cached === undefined,
        };
      });

      let nextStatus: BillingStatus | undefined;
      try {
        nextStatus = await billingApi.status({ refresh });
      } catch {
        // 保留同一用户的上一次余额，在请求失败时结束骨架。
      }
      if (
        request !== latestRequest.current ||
        !isAuthTokenSnapshotCurrent(token)
      ) {
        return;
      }
      setSnapshot((previous) => ({
        userId,
        token,
        status: nextStatus ?? previous.status,
        settled: true,
        refreshing: false,
      }));
    },
    [token, userId],
  );
  const refresh = useCallback(() => load(true), [load]);

  useEffect(() => {
    void load(false);
    if (!userId) return;
    const refreshAfterBillingChanged = () => {
      void refresh();
    };
    window.addEventListener(BILLING_CHANGED_EVENT, refreshAfterBillingChanged);
    return () => {
      latestRequest.current += 1;
      window.removeEventListener(
        BILLING_CHANGED_EVENT,
        refreshAfterBillingChanged,
      );
    };
  }, [load, refresh, userId]);

  const ownSnapshot =
    snapshot.userId === userId && snapshot.token === token ? snapshot : null;
  return {
    status: userId ? ownSnapshot?.status ?? initialSnapshot ?? null : null,
    loading: Boolean(userId && !ownSnapshot?.settled && !initialSnapshot),
    refreshing: Boolean(userId && ownSnapshot?.refreshing),
    refresh,
  };
}
