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
          className="group flex items-center gap-3 rounded-xl border border-hairline bg-surface-raised px-4 py-3.5 transition-colors hover:border-primary/35"
        >
          <ServerCog size={16} className="shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-medium">
              {t('pages.profile.modelTitle')}
            </p>
            <p className="mt-0.5 text-[11px] text-muted">
              {t('pages.profile.modelDescription')}
            </p>
          </div>
          <ChevronRight
            size={14}
            className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-ink"
          />
        </Link>
      </div>
    </AppShell>
  );
}
