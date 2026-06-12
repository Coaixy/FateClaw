'use client';

import { AppShell } from '@/components/app-shell';
import { TabWallet } from '@/components/settings/tab-wallet';
import { useI18n } from '@/lib/i18n';

export function WalletWorkspace() {
  const { t } = useI18n();

  return (
    <AppShell>
      <h2 className="font-display hidden text-base font-semibold tracking-tight mb-5 lg:block">
        {t('pages.wallet.title')}
      </h2>
      <div className="min-h-[70vh]">
        <TabWallet />
      </div>
    </AppShell>
  );
}
