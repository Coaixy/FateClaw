'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { ModelSettingsPanel } from '@/components/settings/model-settings-panel';

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
        <h2 className="hidden lg:block text-base font-semibold tracking-tight">模型设置</h2>
      </div>

      <div className="space-y-6 min-h-[70vh]">
        <ModelSettingsPanel />
      </div>
    </AppShell>
  );
}
