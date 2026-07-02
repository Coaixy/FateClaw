'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Loader2 } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import {
  SkillBundleEditor,
  SkillBundleEditorData,
} from '@/components/skills/skill-bundle-editor';
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

  const handleUpdate = async (data: SkillBundleEditorData) => {
    if (!skillId) return;
    await skillsApi.userUpdate(skillId, data);
    toast('success', 'Skill Bundle 已更新');
    router.push('/studio');
  };

  return (
    <AppShell>
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="space-y-3">
          <Link
            href="/studio"
            className="inline-flex items-center gap-1.5 text-[12px] text-muted transition-colors hover:text-ink"
          >
            <ArrowLeft size={13} />
            返回术数开发
          </Link>
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
          <div className="rounded-2xl border border-error/20 bg-error/10 px-5 py-4 text-[13px] text-error">
            {error}
          </div>
        ) : !skillId ? (
          <div className="rounded-2xl border border-hairline bg-surface-card px-5 py-4 text-[13px] text-muted">
            缺少 skillId 参数，无法编辑技能。
          </div>
        ) : !skill ? (
          <div className="rounded-2xl border border-hairline bg-surface-card px-5 py-4 text-[13px] text-muted">
            没找到这个技能，可能已被删除或你没有访问权限。
          </div>
        ) : (
          <SkillBundleEditor
            initial={skill}
            onSave={handleUpdate}
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
