'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { ModelSettingsPanel } from '@/components/settings/model-settings-panel';
import { TabData } from '@/components/settings/tab-data';

export function AdvancedSettingsWorkspace() {
  return (
    <AppShell>
      <div className="mb-5 space-y-2">
        <Link
          href="/profile"
          className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink transition-colors"
        >
          <ArrowLeft size={13} />
          返回个人资料
        </Link>
        <h2 className="hidden lg:block text-base font-semibold tracking-tight">高级设置</h2>
      </div>

      <div className="space-y-6 min-h-[70vh]">
        <SettingsBlock title="模型设置">
          <ModelSettingsPanel />
        </SettingsBlock>

        <SettingsBlock title="数据管理">
          <TabData />
        </SettingsBlock>
      </div>
    </AppShell>
  );
}

function SettingsBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-medium text-muted tracking-wide uppercase px-1">
        {title}
      </h3>
      {children}
    </section>
  );
}
