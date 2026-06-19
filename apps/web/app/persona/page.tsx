'use client';

import { AppShell } from '@/components/app-shell';
import { UserSoulCard } from '@/components/workspace/user-soul-card';
import { GuashiScriptTemplateCard } from '@/components/workspace/guashi-script-template-card';
import { useI18n } from '@/lib/i18n';

/**
 * 人格设置页面。
 *
 * @returns 独立的人格设置工作区，避免微信对话入口承载过多账户设置能力。
 */
export default function PersonaPage() {
  const { t } = useI18n();

  return (
    <AppShell>
      <div className="min-h-[70vh] space-y-5">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            {t('pages.persona.title')}
          </h2>
          <p className="mt-1 text-[12px] text-muted">
            {t('pages.persona.description')}
          </p>
        </div>

        <section className="rounded-2xl border border-hairline bg-surface-card/50 p-4 lg:p-5">
          <UserSoulCard />
        </section>

        <section className="rounded-2xl border border-hairline bg-surface-card/50 p-4 lg:p-5">
          <GuashiScriptTemplateCard />
        </section>
      </div>
    </AppShell>
  );
}
