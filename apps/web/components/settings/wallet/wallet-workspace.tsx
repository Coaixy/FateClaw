'use client';

import { AppShell } from '@/components/app-shell';
import { TabWallet } from '@/components/settings/tab-wallet';

export function WalletWorkspace() {
  return (
    <AppShell>
      <h2 className="hidden lg:block text-base font-semibold tracking-tight mb-5">钱包</h2>
      <div className="min-h-[70vh]">
        <TabWallet />
      </div>
    </AppShell>
  );
}
