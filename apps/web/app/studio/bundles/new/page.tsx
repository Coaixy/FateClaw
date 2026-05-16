'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Layers, Loader2, Link2 } from 'lucide-react';

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
          <div className="flex flex-col gap-4 rounded-[28px] border border-hairline bg-[linear-gradient(135deg,color-mix(in_srgb,var(--color-primary)_10%,transparent),transparent_45%),var(--color-surface-card)] p-5 sm:p-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted">
                Bundle Builder
              </p>
              <h1 className="mt-2 text-2xl font-bold tracking-tight">
                创建技能捆绑包
              </h1>
              <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted sm:text-sm">
                把多个技能打包成一个分享入口。适合做系列课程、主题合集或新人入门包，用户订阅一次即可批量获得。
              </p>
            </div>
            <div className="grid gap-2 text-[12px] text-muted sm:grid-cols-2">
              <div className="rounded-2xl border border-hairline bg-canvas/50 px-3 py-2.5">
                <div className="flex items-center gap-2 font-medium text-ink">
                  <Layers size={14} className="text-primary" />
                  组合建议
                </div>
                <p className="mt-1 leading-relaxed">
                  把主题相近、使用链路连续的技能放在一起。
                </p>
              </div>
              <div className="rounded-2xl border border-hairline bg-canvas/50 px-3 py-2.5">
                <div className="flex items-center gap-2 font-medium text-ink">
                  <Link2 size={14} className="text-primary" />
                  分享方式
                </div>
                <p className="mt-1 leading-relaxed">
                  创建后可在术数开发中生成统一的订阅链接。
                </p>
              </div>
            </div>
          </div>
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
          <div className="rounded-[28px] border border-red-400/20 bg-red-400/10 px-5 py-4 text-[13px] text-red-300">
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
