'use client';

import Link from 'next/link';
import { ChevronRight, ServerCog } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { TabAccount } from '@/components/settings/tab-account';
import { TabAppearance } from '@/components/settings/tab-appearance';
import { TabSecurity } from '@/components/settings/tab-security';
import { useI18n } from '@/lib/i18n';

export function ProfileWorkspace() {
  const { t } = useI18n();

  return (
    <AppShell>
      <div className="mb-4 space-y-1.5">
        <div className="inline-flex items-center rounded-full border border-hairline bg-surface-card px-2.5 py-1 text-[10px] font-medium text-muted">
          {t('pages.profile.badge')}
        </div>
        <h2 className="text-[15px] font-semibold tracking-tight">
          {t('pages.profile.title')}
        </h2>
        <p className="max-w-[440px] text-[11px] leading-5 text-muted">
          {t('pages.profile.description')}
        </p>
      </div>

      <div className="space-y-3.5 min-h-[70vh]">
        <TabAccount />
        <TabSecurity />
        <TabAppearance />
        <Link
          href="/settings/advanced"
          className="group block overflow-hidden rounded-xl border border-hairline bg-surface-raised transition-colors"
        >
          <div className="border-b border-hairline px-4 py-2.5">
            <div className="flex items-center gap-2.5">
              <ServerCog size={14} className="text-muted" />
              <div>
                <p className="text-[12px] font-medium">
                  {t('pages.profile.modelTitle')}
                </p>
                <p className="text-[10px] text-muted">
                  {t('pages.profile.modelDescription')}
                </p>
              </div>
            </div>
          </div>

          <div className="px-4 py-3">
            <div className="flex items-center justify-between rounded-xl border border-hairline bg-canvas/36 px-3.5 py-3 transition-colors group-hover:bg-surface-cream-strong/70">
              <div className="flex items-center gap-3">
                <div className="flex h-[28px] w-[28px] items-center justify-center rounded-lg bg-surface-card/90">
                  <ServerCog size={13} className="text-muted" />
                </div>
                <div className="text-left">
                  <p className="text-[11px] font-medium">
                    {t('pages.profile.modelEntryTitle')}
                  </p>
                  <p className="text-[10px] text-muted">
                    {t('pages.profile.modelEntryDescription')}
                  </p>
                </div>
              </div>
              <div className="flex h-7 w-7 items-center justify-center rounded-full border border-hairline bg-surface-card/70 transition-colors group-hover:border-primary/35 group-hover:bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)]">
                <ChevronRight size={13} className="text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
              </div>
            </div>
          </div>
        </Link>
      </div>
    </AppShell>
  );
}
