'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, BookOpen, Loader2, Sparkles } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { SkillForm, SkillFormData } from '@/components/skills/skill-form';
import { SkillSkeleton } from '@/components/skills/skill-skeleton';
import { skillsApi, UserCustomSkill } from '@/features/skills/api';
import { useToast } from '@/lib/use-toast';

function EditStudioSkillPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();
  const [skills, setSkills] = useState<UserCustomSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const skillId = searchParams.get('skillId') || '';

  useEffect(() => {
    let cancelled = false;

    skillsApi
      .userList()
      .then((res) => {
        if (cancelled) return;
        setSkills(res.own ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '加载技能失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const skill = useMemo(
    () => skills.find((item) => item.id === skillId) ?? null,
    [skills, skillId],
  );

  const handleUpdate = async (data: SkillFormData) => {
    if (!skillId) return;
    await skillsApi.userUpdate(skillId, data);
    toast('success', '术数技能已更新');
    router.push('/studio');
  };

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="space-y-3">
          <Link
            href="/studio"
            className="inline-flex items-center gap-1.5 text-[12px] text-muted transition-colors hover:text-ink"
          >
            <ArrowLeft size={13} />
            返回术数开发
          </Link>
          <div className="flex flex-col gap-4 rounded-[28px] border border-hairline bg-[linear-gradient(135deg,color-mix(in_srgb,var(--color-primary)_12%,transparent),transparent_45%),var(--color-surface-card)] p-5 sm:p-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted">
                Skill Editor
              </p>
              <h1 className="mt-2 text-2xl font-bold tracking-tight">
                编辑术数技能
              </h1>
              <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted sm:text-sm">
                调整技能描述、路由策略和正文内容。保存后会立即影响后续调用与分享效果。
              </p>
            </div>
            <div className="grid gap-2 text-[12px] text-muted sm:grid-cols-2">
              <div className="rounded-2xl border border-hairline bg-canvas/50 px-3 py-2.5">
                <div className="flex items-center gap-2 font-medium text-ink">
                  <BookOpen size={14} className="text-primary" />
                  编辑建议
                </div>
                <p className="mt-1 leading-relaxed">
                  优先修改关键词、使用方式和内容结构，避免只堆积长文本。
                </p>
              </div>
              <div className="rounded-2xl border border-hairline bg-canvas/50 px-3 py-2.5">
                <div className="flex items-center gap-2 font-medium text-ink">
                  <Sparkles size={14} className="text-primary" />
                  生效范围
                </div>
                <p className="mt-1 leading-relaxed">
                  保存后会回到术数开发，可继续分享、启用或加入捆绑包。
                </p>
              </div>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-[13px] text-muted">
              <Loader2 size={14} className="animate-spin" />
              正在读取技能信息
            </div>
            <SkillSkeleton />
          </div>
        ) : error ? (
          <div className="rounded-[28px] border border-red-400/20 bg-red-400/10 px-5 py-4 text-[13px] text-red-300">
            {error}
          </div>
        ) : !skillId ? (
          <div className="rounded-[28px] border border-hairline bg-surface-card px-5 py-4 text-[13px] text-muted">
            缺少 skillId 参数，无法编辑技能。
          </div>
        ) : !skill ? (
          <div className="rounded-[28px] border border-hairline bg-surface-card px-5 py-4 text-[13px] text-muted">
            没找到这个技能，可能已被删除或你没有访问权限。
          </div>
        ) : (
          <SkillForm
            variant="page"
            initial={skill}
            onSave={handleUpdate}
            onCancel={() => router.push('/studio')}
          />
        )}
      </div>
    </AppShell>
  );
}

export default function EditStudioSkillPage() {
  return (
    <Suspense>
      <EditStudioSkillPageContent />
    </Suspense>
  );
}
