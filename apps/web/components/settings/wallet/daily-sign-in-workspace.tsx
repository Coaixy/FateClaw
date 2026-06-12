'use client';

import { useCallback, useEffect, useState } from 'react';

import { AppShell } from '@/components/app-shell';
import { WalletDailySignInPanel } from '@/components/settings/wallet/wallet-daily-sign-in-panel';
import { billingApi, type DailySignInStatus } from '@/features/billing/api';
import { useI18n } from '@/lib/i18n';

/**
 * 每日签到独立页面容器。
 *
 * 负责拉取签到状态，并把领取后的刷新逻辑收敛在页面内，避免钱包页承担签到入口职责。
 */
export function DailySignInWorkspace() {
  const { t } = useI18n();
  const [status, setStatus] = useState<DailySignInStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError('');

    try {
      setStatus(await billingApi.dailySignInStatus());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t('pages.dailySignIn.statusLoadFailed'),
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AppShell>
      <div className="min-h-[70vh] space-y-5">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            {t('pages.dailySignIn.title')}
          </h2>
          <p className="mt-1 text-[12px] text-muted">
            {t('pages.dailySignIn.description')}
          </p>
        </div>

        {error && (
          <div className="rounded-xl border border-error/30 bg-error/8 px-4 py-3 text-[12px] text-error">
            {error}
          </div>
        )}

        {loading ? (
          <div className="h-[74px] rounded-2xl border border-hairline bg-surface-card animate-pulse" />
        ) : (
          <WalletDailySignInPanel
            status={status}
            refreshing={refreshing}
            onChanged={refresh}
          />
        )}
      </div>
    </AppShell>
  );
}
