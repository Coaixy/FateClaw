'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { ModelSettingsPanel } from '@/components/settings/model-settings-panel';
import { useI18n } from '@/lib/i18n';

export function AdvancedSettingsWorkspace() {
  const { t } = useI18n();

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl">
        <div className="mb-5">
          <Link
            href="/profile"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-1 text-[12px] text-muted transition-colors hover:text-ink"
          >
            <ArrowLeft size={13} />
            {t('pages.modelSettings.backProfile')}
          </Link>
          <h2 className="font-display mt-2 text-xl font-semibold tracking-tight text-ink">
            {t('pages.modelSettings.title')}
          </h2>
          <p className="mt-1 text-[13px] leading-6 text-muted">
            {t('pages.modelSettings.description')}
          </p>
        </div>
        <ModelSettingsPanel />
      </div>
    </AppShell>
  );
}
