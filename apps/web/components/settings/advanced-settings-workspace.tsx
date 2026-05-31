'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { ModelSettingsPanel } from '@/components/settings/model-settings-panel';

export function AdvancedSettingsWorkspace() {
  return (
    <AppShell wide>
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-col gap-4 border-b border-hairline/70 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <Link
              href="/profile"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg px-1 text-[12px] text-muted transition-colors hover:text-ink"
            >
              <ArrowLeft size={13} />
              返回个人资料
            </Link>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-ink">
              模型设置
            </h2>
            <p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted">
              配置官方模型或自配供应商模型，当前选择会用于 AI 对话回复。
            </p>
          </div>
        </div>

        <div className="min-h-[70vh]">
          <ModelSettingsPanel />
        </div>
      </div>
    </AppShell>
  );
}
