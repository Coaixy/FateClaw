'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  BookOpen,
  Layers,
  Loader2,
  Plus,
  Puzzle,
  Share2,
  Upload,
  Users,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { BundleCard } from '@/components/skills/bundle-card';
import { BundleForm } from '@/components/skills/bundle-form';
import { OwnSkillCard } from '@/components/skills/own-skill-card';
import { SkillSkeleton } from '@/components/skills/skill-skeleton';
import { SubscribedBundleGroup } from '@/components/skills/subscribed-bundle-group';
import { SubscribedSkillCard } from '@/components/skills/subscribed-skill-card';
import {
  DEFAULT_SKILL_BUNDLE_LIMITS,
  SkillBundle,
  UserCustomSkill,
  skillsApi,
} from '@/features/skills/api';
import { useBundles } from '@/features/skills/hooks/use-bundles';
import { useUserSkills } from '@/features/skills/hooks/use-user-skills';
import { groupSubscribedSkills } from '@/features/skills/subscription-groups';
import {
  downloadSkillBundleZip,
  importSkillBundleFromZip,
} from '@/features/skills/skill-zip';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { useConfirm } from '@/lib/use-confirm';
import { useToast } from '@/lib/use-toast';

export default function StudioPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { toast } = useToast();
  const { confirm: confirmDialog } = useConfirm();

  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingBundle, setEditingBundle] = useState<SkillBundle | null>(null);
  const [copiedBundleId, setCopiedBundleId] = useState<string | null>(null);
  const [importingSkill, setImportingSkill] = useState(false);
  const [skillLimits, setSkillLimits] = useState(DEFAULT_SKILL_BUNDLE_LIMITS);
  const notify = useCallback(
    (type: 'success' | 'error', message: string) => toast(type, message),
    [toast],
  );
  const userSkills = useUserSkills(notify);
  const bundlesState = useBundles(notify);
  const { ownSkills, subscribedSkills, loadUserSkills, applyUserSkills } =
    userSkills;
  const { bundles, loadBundles, setBundles } = bundlesState;

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    Promise.all([
      skillsApi.userList(),
      skillsApi.bundleList().catch(() => [] as SkillBundle[]),
      skillsApi.limits().catch(() => DEFAULT_SKILL_BUNDLE_LIMITS),
    ])
      .then(([s, b, limits]) => {
        if (cancelled) return;
        applyUserSkills(s);
        setBundles(Array.isArray(b) ? b : []);
        setSkillLimits(limits);
      })
      .catch((err) => {
        if (cancelled) return;
        toast(
          'error',
          err instanceof Error ? err.message : '加载创作者数据失败',
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyUserSkills, setBundles, toast, user]);

  const stats = useMemo(() => {
    const sharedCount = ownSkills.filter(
      (s) => s.visibility !== 'private',
    ).length;
    const totalSubs = ownSkills.reduce(
      (sum, s) => sum + (s.stat_subscriber_count ?? 0),
      0,
    );
    const bundleCount = bundles.length;
    return { sharedCount, totalSubs, bundleCount };
  }, [bundles.length, ownSkills]);

  const subscribedGroups = useMemo(
    () => groupSubscribedSkills(subscribedSkills),
    [subscribedSkills],
  );

  const runWithToast = async (
    fn: () => Promise<void>,
    fallbackMsg: string,
  ): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (err) {
      toast('error', err instanceof Error ? err.message : fallbackMsg);
      return false;
    }
  };

  const handleDelete = async (id: string) => {
    const ok = await confirmDialog({
      title: '删除技能',
      message: '确定删除此技能？',
      confirmLabel: '删除',
      variant: 'danger',
    });
    if (!ok) return;
    const success = await runWithToast(async () => {
      await skillsApi.userDelete(id);
      await loadUserSkills();
    }, '删除失败');
    if (success) toast('success', '已删除');
  };

  const handleImportSkillZip = async (file: File | undefined) => {
    if (!file) return;
    setImportingSkill(true);
    await runWithToast(async () => {
      const imported = await importSkillBundleFromZip(file, skillLimits);
      await skillsApi.userCreate({
        skill_name: imported.skillName,
        files: imported.files,
      });
      await loadUserSkills();
      toast('success', 'Skill ZIP 已导入');
    }, '导入 Skill ZIP 失败');
    setImportingSkill(false);
  };

  const handleExportSkillZip = (skill: UserCustomSkill) => {
    try {
      downloadSkillBundleZip(skill.skill_name, skill.files, skillLimits);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '导出 Skill ZIP 失败');
    }
  };

  const handleToggle = async (id: string) => {
    await runWithToast(async () => {
      await skillsApi.userToggle(id);
      await loadUserSkills();
    }, '切换状态失败');
  };

  const handleShare = async (id: string) => {
    await runWithToast(async () => {
      const current = ownSkills.find((skill) => skill.id === id);
      let shareToken = current?.share_token ?? null;
      if (!shareToken) {
        const res = await skillsApi.share(id);
        shareToken = res.share_token;
        await loadUserSkills();
      }
      if (!shareToken) throw new Error('分享链接生成失败');
      const url = `${window.location.origin}/skills/install?token=${encodeURIComponent(shareToken)}`;
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      toast('success', '私密链接已复制到剪贴板');
      setTimeout(() => setCopiedId(null), 2000);
    }, '复制链接失败');
  };

  const handleSkillAccessInvite = async (id: string) => {
    await runWithToast(async () => {
      const res = await skillsApi.accessInviteCreate({
        target_type: 'skill',
        target_id: id,
      });
      const url = `${window.location.origin}${res.install_url}`;
      await navigator.clipboard.writeText(url);
      toast('success', '作者授权链接已复制到剪贴板');
    }, '生成授权链接失败');
  };

  const handleUnshare = async (id: string) => {
    const success = await runWithToast(async () => {
      await skillsApi.unshare(id);
      await loadUserSkills();
    }, '关闭私密链接分享失败');
    if (success) toast('success', '已关闭私密链接分享');
  };

  const handlePublish = async (id: string) => {
    const success = await runWithToast(async () => {
      await skillsApi.publish(id);
      await loadUserSkills();
    }, '公开上架失败');
    if (success) toast('success', '已公开上架');
  };

  const handleUnpublish = async (id: string) => {
    const success = await runWithToast(async () => {
      await skillsApi.unpublish(id);
      await loadUserSkills();
    }, '取消公开失败');
    if (success) toast('success', '已取消公开，保留私密链接');
  };

  const handleSubscriptionToggle = async (subId: string) => {
    await runWithToast(async () => {
      await skillsApi.subscriptionToggle(subId);
      await loadUserSkills();
    }, '切换订阅状态失败');
  };

  const handleUnsubscribe = async (subId: string) => {
    const ok = await confirmDialog({
      title: '取消订阅',
      message: '确定取消订阅此技能？',
      confirmLabel: '取消订阅',
      variant: 'danger',
    });
    if (!ok) return;
    const success = await runWithToast(async () => {
      await skillsApi.unsubscribe(subId);
      await loadUserSkills();
    }, '取消订阅失败');
    if (success) toast('success', '已取消订阅');
  };

  const handleBundleUnsubscribe = async (bundleId: string) => {
    const ok = await confirmDialog({
      title: '取消整包订阅',
      message: '确定取消这个捆绑包下的全部订阅？',
      confirmLabel: '整包取消',
      variant: 'danger',
    });
    if (!ok) return;
    const success = await runWithToast(async () => {
      await skillsApi.bundleUnsubscribe(bundleId);
      await loadUserSkills();
    }, '取消捆绑包订阅失败');
    if (success) toast('success', '已取消捆绑包订阅');
  };

  const handleBundleUpdate = async (
    data: Parameters<typeof skillsApi.bundleUpdate>[1],
  ) => {
    if (!editingBundle) return;
    await skillsApi.bundleUpdate(editingBundle.id, data);
    setEditingBundle(null);
    await loadBundles();
    toast('success', '捆绑包已更新');
  };

  const handleBundleDelete = async (id: string) => {
    const ok = await confirmDialog({
      title: '删除捆绑包',
      message: '删除后分享链接立即失效（已订阅的技能不受影响）',
      confirmLabel: '删除',
      variant: 'danger',
    });
    if (!ok) return;
    const success = await runWithToast(async () => {
      await skillsApi.bundleDelete(id);
      await loadBundles();
    }, '删除失败');
    if (success) toast('success', '已删除');
  };

  const handleBundleShare = async (id: string) => {
    await runWithToast(async () => {
      const current = bundles.find((bundle) => bundle.id === id);
      let bundleToken = current?.bundle_token ?? null;
      if (!bundleToken) {
        const res = await skillsApi.bundleShare(id);
        bundleToken = res.bundle_token;
        await loadBundles();
      }
      if (!bundleToken) throw new Error('分享链接生成失败');
      const url = `${window.location.origin}/skills/bundle/install?token=${encodeURIComponent(bundleToken)}`;
      await navigator.clipboard.writeText(url);
      setCopiedBundleId(id);
      toast('success', '私密链接已复制到剪贴板');
      setTimeout(() => setCopiedBundleId(null), 2000);
    }, '复制链接失败');
  };

  const handleBundleAccessInvite = async (id: string) => {
    await runWithToast(async () => {
      const res = await skillsApi.accessInviteCreate({
        target_type: 'bundle',
        target_id: id,
      });
      const url = `${window.location.origin}${res.install_url}`;
      await navigator.clipboard.writeText(url);
      toast('success', '作者授权链接已复制到剪贴板');
    }, '生成授权链接失败');
  };

  const handleBundleUnshare = async (id: string) => {
    const success = await runWithToast(async () => {
      await skillsApi.bundleUnshare(id);
      await loadBundles();
    }, '关闭私密链接分享失败');
    if (success) toast('success', '已关闭私密链接分享');
  };

  const handleBundlePublish = async (id: string) => {
    const success = await runWithToast(async () => {
      await skillsApi.bundlePublish(id);
      await loadBundles();
    }, '公开上架失败');
    if (success) toast('success', '已公开上架');
  };

  const handleBundleUnpublish = async (id: string) => {
    const success = await runWithToast(async () => {
      await skillsApi.bundleUnpublish(id);
      await loadBundles();
    }, '取消公开失败');
    if (success) toast('success', '已取消公开，保留私密链接');
  };

  return (
    <AppShell>
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Header */}
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <div className="hidden lg:block">
            <h1 className="text-2xl font-bold tracking-tight">术数开发</h1>
            <p className="mt-1 text-sm text-muted">
              打造可分享、可复用的命理术数技能
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label
              className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-hairline bg-surface-card text-sm font-medium text-ink transition-colors ${
                importingSkill
                  ? 'cursor-not-allowed opacity-60'
                  : 'cursor-pointer hover:bg-surface-cream-strong'
              }`}
            >
              {importingSkill ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              导入 Skill
              <input
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                disabled={importingSkill}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  void handleImportSkillZip(file);
                }}
              />
            </label>
            <Link
              href="/studio/bundles/new"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-hairline bg-surface-card text-sm font-medium text-ink transition-colors hover:bg-surface-cream-strong"
            >
              <Layers className="w-4 h-4" />
              创建捆绑包
            </Link>
            <Link
              href="/studio/skills/new"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary text-white text-sm font-medium hover:opacity-90 transition-opacity"
            >
              <Plus className="w-4 h-4" />
              开发术数
            </Link>
          </div>
        </header>

        {/* Stat cards */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="已共享技能"
            value={String(stats.sharedCount)}
            Icon={Puzzle}
            hint="链接分享或公开上架"
          />
          <StatCard
            label="技能捆绑包"
            value={String(stats.bundleCount)}
            Icon={Layers}
          />
          <StatCard
            label="总订阅人数"
            value={String(stats.totalSubs)}
            Icon={Users}
          />
          <StatCard
            label="自有技能"
            value={String(ownSkills.length)}
            Icon={BookOpen}
          />
        </section>

        {/* 我的知识技能 */}
        <section>
          <SectionTitle
            icon={Puzzle}
            title="我的知识技能"
            count={loading ? undefined : ownSkills.length}
            subtitle="沉淀你的流派、规则和解读方法"
          />

          <div className="mt-5 space-y-3">
            {loading ? (
              <>
                <SkillSkeleton />
                <SkillSkeleton />
              </>
            ) : ownSkills.length === 0 ? (
              <div className="group relative overflow-hidden rounded-2xl border border-dashed border-hairline py-14 transition-all duration-300 hover:border-[color-mix(in_srgb,var(--color-primary)_50%,var(--color-hairline))]">
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,color-mix(in_srgb,var(--color-primary)_3%,transparent),transparent_70%)] pointer-events-none" />
                <div className="relative flex flex-col items-center text-center">
                  <div className="w-14 h-14 rounded-2xl bg-surface-card border border-hairline flex items-center justify-center mx-auto mb-4 group-hover:shadow-[0_0_20px_color-mix(in_srgb,var(--color-primary)_10%,transparent)] transition-shadow">
                    <BookOpen
                      size={20}
                      className="text-muted group-hover:text-primary transition-colors"
                    />
                  </div>
                  <p className="max-w-[18rem] text-[14px] text-muted font-medium group-hover:text-ink transition-colors">
                    开发你的第一个术数技能
                  </p>
                  <p className="mt-1.5 max-w-[22rem] text-[12px] text-muted opacity-60">
                    把排盘经验、解读规则和流派方法封装起来
                  </p>
                  <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                    <Link
                      href="/studio/skills/new"
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-semibold text-white transition-opacity hover:opacity-90"
                    >
                      <Plus size={13} />
                      新建 Skill
                    </Link>
                    <label
                      className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-hairline bg-surface-card px-3 text-[12px] font-semibold text-ink transition-colors ${
                        importingSkill
                          ? 'cursor-not-allowed opacity-60'
                          : 'cursor-pointer hover:bg-surface-cream-strong'
                      }`}
                    >
                      {importingSkill ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Upload size={13} />
                      )}
                      上传 ZIP
                      <input
                        type="file"
                        accept=".zip,application/zip"
                        className="hidden"
                        disabled={importingSkill}
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = '';
                          void handleImportSkillZip(file);
                        }}
                      />
                    </label>
                  </div>
                </div>
              </div>
            ) : (
              ownSkills.map((sk) => (
                <OwnSkillCard
                  key={sk.id}
                  sk={sk}
                  copiedId={copiedId}
                  onToggle={handleToggle}
                  onCopyLink={handleShare}
                  onCopyInviteLink={handleSkillAccessInvite}
                  onUnshare={handleUnshare}
                  onPublish={handlePublish}
                  onUnpublish={handleUnpublish}
                  onEdit={(skill) =>
                    router.push(
                      `/studio/skills/edit?skillId=${encodeURIComponent(skill.id)}`,
                    )
                  }
                  onExport={handleExportSkillZip}
                  onDelete={handleDelete}
                />
              ))
            )}
          </div>
        </section>

        {/* 我的捆绑包 */}
        <section>
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden sm:flex w-8 h-8 rounded-xl bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] items-center justify-center shrink-0">
              <Layers size={14} className="text-primary" />
            </div>
            <h3 className="text-[13px] font-semibold tracking-tight">
              我的捆绑包
            </h3>
            {!loading && (
              <span className="text-[11px] text-muted tabular-nums bg-surface-card px-1.5 py-0.5 rounded-md">
                {bundles.length}
              </span>
            )}
            <div className="flex-1" />
            <Link
              href="/studio/bundles/new"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] text-muted hover:text-ink hover:bg-surface-cream-strong transition-colors"
            >
              <Plus size={12} />
              新建
            </Link>
          </div>

          <div className="mt-5 space-y-3">
            {loading ? (
              <SkillSkeleton />
            ) : bundles.length === 0 ? (
              <div className="relative py-10 text-center rounded-2xl border border-dashed border-hairline overflow-hidden">
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,color-mix(in_srgb,var(--color-primary)_3%,transparent),transparent_70%)] pointer-events-none" />
                <p className="relative text-[12px] text-muted opacity-70">
                  把多个技能组合成一个捆绑包，一次分享即可全部订阅
                </p>
              </div>
            ) : (
              bundles.map((b) => (
                <BundleCard
                  key={b.id}
                  bundle={b}
                  copiedId={copiedBundleId}
                  onCopyLink={handleBundleShare}
                  onCopyInviteLink={handleBundleAccessInvite}
                  onUnshare={handleBundleUnshare}
                  onPublish={handleBundlePublish}
                  onUnpublish={handleBundleUnpublish}
                  onEdit={setEditingBundle}
                  onDelete={handleBundleDelete}
                />
              ))
            )}
          </div>
        </section>

        {/* 已订阅 */}
        <section>
          <SectionTitle
            icon={Share2}
            title="已订阅"
            count={loading ? undefined : subscribedSkills.length}
            subtitle="通过分享链接订阅的他人技能"
          />

          <div className="mt-5 space-y-3">
            {loading ? (
              <SkillSkeleton />
            ) : subscribedSkills.length === 0 ? (
              <div className="relative py-10 text-center rounded-2xl border border-dashed border-hairline overflow-hidden">
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgb(59_130_246/0.02),transparent_70%)] pointer-events-none" />
                <p className="relative text-[12px] text-muted opacity-60">
                  通过技能市场或分享链接订阅他人的术数技能
                </p>
              </div>
            ) : (
              <>
                {subscribedGroups.bundles.map((group) => (
                  <SubscribedBundleGroup
                    key={group.bundleId}
                    group={group}
                    onUnsubscribeBundle={handleBundleUnsubscribe}
                  />
                ))}
                {subscribedGroups.direct.map((sk) => (
                  <SubscribedSkillCard
                    key={sk.subscription_id}
                    sk={sk}
                    onToggle={handleSubscriptionToggle}
                    onUnsubscribe={handleUnsubscribe}
                  />
                ))}
              </>
            )}
          </div>
        </section>
      </div>

      {/* Modals */}
      {editingBundle && (
        <BundleForm
          initial={editingBundle}
          ownSkills={ownSkills}
          onSave={handleBundleUpdate}
          onCancel={() => setEditingBundle(null)}
        />
      )}
    </AppShell>
  );
}

function StatCard({
  label,
  value,
  Icon,
  hint,
}: {
  label: string;
  value: string;
  Icon: React.ElementType;
  hint?: string;
}) {
  return (
    <div className="p-4 rounded-2xl border border-hairline bg-surface-card">
      <div className="flex items-center gap-2 mb-2 text-muted">
        <Icon className="w-4 h-4" />
        <span className="text-xs">{label}</span>
      </div>
      <p className="text-xl font-bold tracking-tight tabular-nums">{value}</p>
      {hint && (
        <p className="mt-0.5 text-[10px] text-muted">{hint}</p>
      )}
    </div>
  );
}

function SectionTitle({
  icon: Icon,
  title,
  count,
  subtitle,
}: {
  icon: typeof Puzzle;
  title: string;
  count?: number;
  subtitle?: string;
}) {
  return (
    <div className="flex items-start gap-3 sm:gap-4">
      <div className="mt-0.5 hidden sm:flex w-8 h-8 rounded-xl bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] items-center justify-center shrink-0">
        <Icon size={14} className="text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 sm:gap-2.5">
          <h3 className="text-[14px] font-semibold tracking-tight">{title}</h3>
          {count !== undefined && (
            <span className="shrink-0 text-[11px] text-muted tabular-nums bg-surface-card px-1.5 py-0.5 rounded-md">
              {count}
            </span>
          )}
        </div>
        {subtitle && (
          <p className="mt-1 text-[12px] leading-relaxed text-muted opacity-80">
            {subtitle}
          </p>
        )}
      </div>
    </div>
  );
}
