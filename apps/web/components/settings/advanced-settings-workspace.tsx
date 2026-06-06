'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { ModelSettingsPanel } from '@/components/settings/model-settings-panel';
import { appendGuideResume, normalizeReturnTo } from '@/lib/return-to';

export function AdvancedSettingsWorkspace() {
  const [guideReturnHref, setGuideReturnHref] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('guide') !== 'resume') {
      setGuideReturnHref(null);
      return;
    }

    setGuideReturnHref(
      appendGuideResume(
        normalizeReturnTo(params.get('returnTo')) ?? '/ai-chat',
      ),
    );
  }, []);

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
            <h2 className="font-display mt-2 text-xl font-semibold tracking-tight text-ink">
              模型设置
            </h2>
            <p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted">
              配置官方模型或自配供应商模型，当前选择会用于 AI 对话回复。
            </p>
          </div>
          {guideReturnHref && (
            <Link
              href={guideReturnHref}
              className="inline-flex h-10 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 px-3 text-[12px] font-medium text-primary transition-colors hover:border-primary/40 hover:bg-primary/15"
            >
              返回 AI Chat 继续向导
            </Link>
          )}
        </div>

        <div className="min-h-[70vh]">
          <ModelSettingsPanel />
        </div>
      </div>
    </AppShell>
  );
}
