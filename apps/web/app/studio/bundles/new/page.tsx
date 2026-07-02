'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2 } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { BundleForm, BundleFormData } from '@/components/skills/bundle-form';
import { SkillSkeleton } from '@/components/skills/skill-skeleton';
import { skillsApi, UserCustomSkill } from '@/features/skills/api';
import { useToast } from '@/lib/use-toast';

export default function NewStudioBundlePage() {
  const router = useRouter();
  const { toast } = useToast();
  const [ownSkills, setOwnSkills] = useState<UserCustomSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    skillsApi
      .userList()
      .then((res) => {
        if (cancelled) return;
        setOwnSkills(res.own ?? []);
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

  const handleCreate = async (data: BundleFormData) => {
    await skillsApi.bundleCreate(data);
    toast('success', '捆绑包已创建');
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
        </div>

        {loading ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-[13px] text-muted">
              <Loader2 size={14} className="animate-spin" />
              正在读取你的技能列表
            </div>
            <SkillSkeleton />
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-error/20 bg-error/10 px-5 py-4 text-[13px] text-error">
            {error}
          </div>
        ) : (
          <div className="space-y-4">
            {ownSkills.length === 0 && (
              <div className="rounded-2xl border border-dashed border-hairline bg-surface-card px-5 py-4 text-[13px] text-muted">
                你还没有可加入捆绑包的技能。
                <Link
                  href="/studio/skills/new"
                  className="ml-2 inline-flex items-center font-medium text-primary hover:opacity-80"
                >
                  先去创建技能
                </Link>
              </div>
            )}
            <BundleForm
              variant="page"
              ownSkills={ownSkills}
              onSave={handleCreate}
              onCancel={() => router.push('/studio')}
            />
          </div>
        )}
      </div>
    </AppShell>
  );
}
