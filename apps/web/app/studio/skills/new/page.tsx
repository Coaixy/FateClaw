'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ListChecks } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { SkillForm, SkillFormData } from '@/components/skills/skill-form';
import {
  skillsApi,
  SYSTEM_PAIPAN_CATEGORIES,
} from '@/features/skills/api';
import { useToast } from '@/lib/use-toast';

export default function NewStudioSkillPage() {
  const router = useRouter();
  const { toast } = useToast();

  const handleCreate = async (data: SkillFormData) => {
    await skillsApi.userCreate(data);
    toast('success', '术数技能已创建');
    router.push('/studio');
  };

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="space-y-3">
          <Link
            href="/studio"
            className="inline-flex items-center gap-1.5 text-[12px] text-muted transition-colors hover:text-ink"
          >
            <ArrowLeft size={13} />
            返回术数开发
          </Link>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted">
                Skill Composer
              </p>
              <h1 className="mt-2 text-2xl font-bold tracking-tight">
                分步开发术数技能
              </h1>
              <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted sm:text-sm">
                按基础信息、匹配与使用、知识内容和发布检查推进，把规则沉淀成可复用技能。
              </p>
            </div>
            <div className="inline-flex w-fit items-center gap-2 rounded-2xl border border-hairline bg-surface-card px-3 py-2 text-[12px] font-medium text-muted">
              <ListChecks size={14} className="text-primary" />
              4 步完成创建
            </div>
          </div>
        </div>

        <SkillForm
          variant="page"
          flow="stepped"
          categorySuggestions={SYSTEM_PAIPAN_CATEGORIES}
          onSave={handleCreate}
          onCancel={() => router.push('/studio')}
        />
      </div>
    </AppShell>
  );
}
