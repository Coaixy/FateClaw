'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Layers,
  Loader2,
  Plus,
  Puzzle,
  Search,
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
  type SkillBundle,
  type SubscribedSkill,
  type UserCustomSkill,
  skillsApi,
} from '@/features/skills/api';
import { useBundles } from '@/features/skills/hooks/use-bundles';
import { useUserSkills } from '@/features/skills/hooks/use-user-skills';
import {
  type SkillSubscriptionGroup,
  groupSubscribedSkills,
} from '@/features/skills/subscription-groups';
import {
  downloadSkillBundleZip,
  importSkillBundleFromZip,
} from '@/features/skills/skill-zip';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { useConfirm } from '@/lib/use-confirm';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';

const STUDIO_LIST_PAGE_SIZE = 4;

type SubscribedListItem =
  | {
      type: 'bundle';
      key: string;
      group: SkillSubscriptionGroup;
    }
  | {
      type: 'skill';
      key: string;
      skill: SubscribedSkill;
    };

function normalizeSearch(value: string) {
  return value.trim().toLowerCase();
}

function matchesSearch(
  fields: Array<string | number | null | undefined>,
  query: string,
) {
  if (!query) return true;
  return fields.some((field) =>
    String(field ?? '').toLowerCase().includes(query),
  );
}

function paginateItems<T>(items: T[], page: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const start = (currentPage - 1) * pageSize;
  return {
    currentPage,
    totalPages,
    items: items.slice(start, start + pageSize),
  };
}

export default function StudioPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { toast } = useToast();
  const { confirm: confirmDialog } = useConfirm();
  const { formatNumber, t } = useI18n();

  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingBundle, setEditingBundle] = useState<SkillBundle | null>(null);
  const [copiedBundleId, setCopiedBundleId] = useState<string | null>(null);
  const [importingSkill, setImportingSkill] = useState(false);
  const [skillLimits, setSkillLimits] = useState(DEFAULT_SKILL_BUNDLE_LIMITS);
  const [subscriptionSearch, setSubscriptionSearch] = useState('');
  const [bundleSearch, setBundleSearch] = useState('');
  const [skillSearch, setSkillSearch] = useState('');
  const [subscriptionPage, setSubscriptionPage] = useState(1);
  const [bundlePage, setBundlePage] = useState(1);
  const [skillPage, setSkillPage] = useState(1);
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
          err instanceof Error ? err.message : t('pages.studio.loadFailed'),
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

  const subscribedItems = useMemo<SubscribedListItem[]>(
    () => [
      ...subscribedGroups.bundles.map((group) => ({
        type: 'bundle' as const,
        key: `bundle:${group.bundleId}`,
        group,
      })),
      ...subscribedGroups.direct.map((skill) => ({
        type: 'skill' as const,
        key: `skill:${skill.subscription_id}`,
        skill,
      })),
    ],
    [subscribedGroups],
  );

  const filteredSubscribedItems = useMemo(() => {
    const query = normalizeSearch(subscriptionSearch);
    return subscribedItems.filter((item) => {
      if (item.type === 'bundle') {
        return matchesSearch(
          [
            item.group.bundleName,
            ...item.group.skills.flatMap((skill) => [
              skill.skill_name,
              skill.description,
              skill.author_label,
            ]),
          ],
          query,
        );
      }

      return matchesSearch(
        [item.skill.skill_name, item.skill.description, item.skill.author_label],
        query,
      );
    });
  }, [subscribedItems, subscriptionSearch]);

  const filteredBundles = useMemo(() => {
    const query = normalizeSearch(bundleSearch);
    return bundles.filter((bundle) =>
      matchesSearch(
        [bundle.name, bundle.description, bundle.skill_ids.length],
        query,
      ),
    );
  }, [bundleSearch, bundles]);

  const filteredOwnSkills = useMemo(() => {
    const query = normalizeSearch(skillSearch);
    return ownSkills.filter((skill) =>
      matchesSearch(
        [
          skill.skill_name,
          skill.description,
          skill.content_length,
          skill.stat_subscriber_count,
        ],
        query,
      ),
    );
  }, [ownSkills, skillSearch]);

  const pagedSubscribedItems = useMemo(
    () =>
      paginateItems(
        filteredSubscribedItems,
        subscriptionPage,
        STUDIO_LIST_PAGE_SIZE,
      ),
    [filteredSubscribedItems, subscriptionPage],
  );
  const pagedBundles = useMemo(
    () => paginateItems(filteredBundles, bundlePage, STUDIO_LIST_PAGE_SIZE),
    [bundlePage, filteredBundles],
  );
  const pagedOwnSkills = useMemo(
    () => paginateItems(filteredOwnSkills, skillPage, STUDIO_LIST_PAGE_SIZE),
    [filteredOwnSkills, skillPage],
  );

  useEffect(() => {
    setSubscriptionPage(1);
  }, [subscriptionSearch]);

  useEffect(() => {
    setBundlePage(1);
  }, [bundleSearch]);

  useEffect(() => {
    setSkillPage(1);
  }, [skillSearch]);

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
      title: t('pages.studio.deleteSkillTitle'),
      message: t('pages.studio.deleteSkillMessage'),
      confirmLabel: t('pages.studio.delete'),
      variant: 'danger',
    });
    if (!ok) return;
    const success = await runWithToast(async () => {
      await skillsApi.userDelete(id);
      await loadUserSkills();
    }, t('pages.studio.deleteFailed'));
    if (success) toast('success', t('pages.studio.deleted'));
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
      toast('success', t('pages.studio.skillZipImported'));
    }, t('pages.studio.importZipFailed'));
    setImportingSkill(false);
  };

  const handleExportSkillZip = (skill: UserCustomSkill) => {
    try {
      downloadSkillBundleZip(skill.skill_name, skill.files, skillLimits);
    } catch (err) {
      toast(
        'error',
        err instanceof Error ? err.message : t('pages.studio.exportZipFailed'),
      );
    }
  };

  const handleToggle = async (id: string) => {
    await runWithToast(async () => {
      await skillsApi.userToggle(id);
      await loadUserSkills();
    }, t('pages.studio.toggleFailed'));
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
      if (!shareToken) throw new Error(t('pages.studio.shareLinkMissing'));
      const url = `${window.location.origin}/skills/install?token=${encodeURIComponent(shareToken)}`;
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      toast('success', t('pages.studio.privateLinkCopied'));
      setTimeout(() => setCopiedId(null), 2000);
    }, t('pages.studio.copyLinkFailed'));
  };

  const handleSkillAccessInvite = async (id: string) => {
    await runWithToast(async () => {
      const res = await skillsApi.accessInviteCreate({
        target_type: 'skill',
        target_id: id,
      });
      const url = `${window.location.origin}${res.install_url}`;
      await navigator.clipboard.writeText(url);
      toast('success', t('pages.studio.authorInviteCopied'));
    }, t('pages.studio.authorInviteFailed'));
  };

  const handleUnshare = async (id: string) => {
    const success = await runWithToast(async () => {
      await skillsApi.unshare(id);
      await loadUserSkills();
    }, t('pages.studio.unshareFailed'));
    if (success) toast('success', t('pages.studio.unshared'));
  };

  const handlePublish = async (id: string) => {
    const success = await runWithToast(async () => {
      await skillsApi.publish(id);
      await loadUserSkills();
    }, t('pages.studio.publishFailed'));
    if (success) toast('success', t('pages.studio.published'));
  };

  const handleUnpublish = async (id: string) => {
    const success = await runWithToast(async () => {
      await skillsApi.unpublish(id);
      await loadUserSkills();
    }, t('pages.studio.unpublishFailed'));
    if (success) toast('success', t('pages.studio.unpublished'));
  };

  const handleSubscriptionToggle = async (subId: string) => {
    await runWithToast(async () => {
      await skillsApi.subscriptionToggle(subId);
      await loadUserSkills();
    }, t('pages.studio.toggleFailed'));
  };

  const handleUnsubscribe = async (subId: string) => {
    const ok = await confirmDialog({
      title: t('pages.studio.unsubscribeTitle'),
      message: t('pages.studio.unsubscribeMessage'),
      confirmLabel: t('pages.studio.unsubscribeConfirm'),
      variant: 'danger',
    });
    if (!ok) return;
    const success = await runWithToast(async () => {
      await skillsApi.unsubscribe(subId);
      await loadUserSkills();
    }, t('pages.studio.unsubscribeFailed'));
    if (success) toast('success', t('pages.studio.unsubscribed'));
  };

  const handleBundleUnsubscribe = async (bundleId: string) => {
    const ok = await confirmDialog({
      title: t('pages.studio.bundleUnsubscribeTitle'),
      message: t('pages.studio.bundleUnsubscribeMessage'),
      confirmLabel: t('pages.studio.bundleUnsubscribeConfirm'),
      variant: 'danger',
    });
    if (!ok) return;
    const success = await runWithToast(async () => {
      await skillsApi.bundleUnsubscribe(bundleId);
      await loadUserSkills();
    }, t('pages.studio.bundleUnsubscribeFailed'));
    if (success) toast('success', t('pages.studio.bundleUnsubscribed'));
  };

  const handleBundleUpdate = async (
    data: Parameters<typeof skillsApi.bundleUpdate>[1],
  ) => {
    if (!editingBundle) return;
    await skillsApi.bundleUpdate(editingBundle.id, data);
    setEditingBundle(null);
    await loadBundles();
    toast('success', t('pages.studio.bundleUpdated'));
  };

  const handleBundleDelete = async (id: string) => {
    const ok = await confirmDialog({
      title: t('pages.studio.bundleDeleteTitle'),
      message: t('pages.studio.bundleDeleteMessage'),
      confirmLabel: t('pages.studio.delete'),
      variant: 'danger',
    });
    if (!ok) return;
    const success = await runWithToast(async () => {
      await skillsApi.bundleDelete(id);
      await loadBundles();
    }, t('pages.studio.deleteFailed'));
    if (success) toast('success', t('pages.studio.deleted'));
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
      if (!bundleToken) throw new Error(t('pages.studio.shareLinkMissing'));
      const url = `${window.location.origin}/skills/bundle/install?token=${encodeURIComponent(bundleToken)}`;
      await navigator.clipboard.writeText(url);
      setCopiedBundleId(id);
      toast('success', t('pages.studio.privateLinkCopied'));
      setTimeout(() => setCopiedBundleId(null), 2000);
    }, t('pages.studio.copyLinkFailed'));
  };

  const handleBundleAccessInvite = async (id: string) => {
    await runWithToast(async () => {
      const res = await skillsApi.accessInviteCreate({
        target_type: 'bundle',
        target_id: id,
      });
      const url = `${window.location.origin}${res.install_url}`;
      await navigator.clipboard.writeText(url);
      toast('success', t('pages.studio.authorInviteCopied'));
    }, t('pages.studio.authorInviteFailed'));
  };

  const handleBundleUnshare = async (id: string) => {
    const success = await runWithToast(async () => {
      await skillsApi.bundleUnshare(id);
      await loadBundles();
    }, t('pages.studio.unshareFailed'));
    if (success) toast('success', t('pages.studio.unshared'));
  };

  const handleBundlePublish = async (id: string) => {
    const success = await runWithToast(async () => {
      await skillsApi.bundlePublish(id);
      await loadBundles();
    }, t('pages.studio.publishFailed'));
    if (success) toast('success', t('pages.studio.published'));
  };

  const handleBundleUnpublish = async (id: string) => {
    const success = await runWithToast(async () => {
      await skillsApi.bundleUnpublish(id);
      await loadBundles();
    }, t('pages.studio.unpublishFailed'));
    if (success) toast('success', t('pages.studio.unpublished'));
  };

  return (
    <AppShell>
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Header */}
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <div className="hidden lg:block">
            <h1 className="text-2xl font-bold tracking-tight">
              {t('pages.studio.title')}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {t('pages.studio.description')}
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
              {t('pages.studio.importSkill')}
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
              {t('pages.studio.createBundle')}
            </Link>
            <Link
              href="/studio/skills/new"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary text-white text-sm font-medium hover:opacity-90 transition-opacity"
            >
              <Plus className="w-4 h-4" />
              {t('pages.studio.createSkill')}
            </Link>
          </div>
        </header>

        {/* Stat cards */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label={t('pages.studio.sharedSkills')}
            value={formatNumber(stats.sharedCount)}
            Icon={Puzzle}
            hint={t('pages.studio.sharedSkillsHint')}
          />
          <StatCard
            label={t('pages.studio.skillBundles')}
            value={formatNumber(stats.bundleCount)}
            Icon={Layers}
          />
          <StatCard
            label={t('pages.studio.totalSubscribers')}
            value={formatNumber(stats.totalSubs)}
            Icon={Users}
          />
          <StatCard
            label={t('pages.studio.ownSkills')}
            value={formatNumber(ownSkills.length)}
            Icon={BookOpen}
          />
        </section>

        {/* 别人的订阅 */}
        <section>
          <SectionTitle
            icon={Share2}
            title={t('pages.studio.subscribedTitle')}
            count={loading ? undefined : subscribedSkills.length}
            subtitle={t('pages.studio.subscribedSubtitle')}
          />

          <div className="mt-5 space-y-3">
            {loading ? (
              <SkillSkeleton />
            ) : subscribedSkills.length === 0 ? (
              <div className="relative py-10 text-center rounded-2xl border border-dashed border-hairline overflow-hidden">
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgb(59_130_246/0.02),transparent_70%)] pointer-events-none" />
                <p className="relative text-[12px] text-muted opacity-60">
                  {t('pages.studio.subscribedEmpty')}
                </p>
              </div>
            ) : (
              <>
                <ListSearch
                  value={subscriptionSearch}
                  onChange={setSubscriptionSearch}
                  placeholder={t('pages.studio.subscribedSearchPlaceholder')}
                />
                {filteredSubscribedItems.length === 0 ? (
                  <ListEmptyMessage
                    message={t('pages.studio.noSearchResults', {
                      query: subscriptionSearch.trim(),
                    })}
                  />
                ) : (
                  <>
                    <div className="space-y-3">
                      {pagedSubscribedItems.items.map((item) =>
                        item.type === 'bundle' ? (
                          <SubscribedBundleGroup
                            key={item.key}
                            group={item.group}
                            onUnsubscribeBundle={handleBundleUnsubscribe}
                          />
                        ) : (
                          <SubscribedSkillCard
                            key={item.key}
                            sk={item.skill}
                            onToggle={handleSubscriptionToggle}
                            onUnsubscribe={handleUnsubscribe}
                          />
                        ),
                      )}
                    </div>
                    <PaginationControls
                      currentPage={pagedSubscribedItems.currentPage}
                      totalPages={pagedSubscribedItems.totalPages}
                      totalItems={filteredSubscribedItems.length}
                      pageSize={STUDIO_LIST_PAGE_SIZE}
                      onPageChange={setSubscriptionPage}
                      formatNumber={formatNumber}
                      t={t}
                    />
                  </>
                )}
              </>
            )}
          </div>
        </section>

        {/* 我的捆绑包 */}
        <section>
          <div className="flex items-start justify-between gap-3">
            <SectionTitle
              icon={Layers}
              title={t('pages.studio.bundlesTitle')}
              count={loading ? undefined : bundles.length}
            />
            <Link
              href="/studio/bundles/new"
              className="inline-flex shrink-0 items-center gap-1 px-2.5 py-1 rounded-md text-[11px] text-muted hover:text-ink hover:bg-surface-cream-strong transition-colors"
            >
              <Plus size={12} />
              {t('pages.studio.newBundle')}
            </Link>
          </div>

          <div className="mt-5 space-y-3">
            {loading ? (
              <SkillSkeleton />
            ) : bundles.length === 0 ? (
              <div className="relative py-10 text-center rounded-2xl border border-dashed border-hairline overflow-hidden">
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,color-mix(in_srgb,var(--color-primary)_3%,transparent),transparent_70%)] pointer-events-none" />
                <p className="relative text-[12px] text-muted opacity-70">
                  {t('pages.studio.bundlesEmpty')}
                </p>
              </div>
            ) : (
              <>
                <ListSearch
                  value={bundleSearch}
                  onChange={setBundleSearch}
                  placeholder={t('pages.studio.bundlesSearchPlaceholder')}
                />
                {filteredBundles.length === 0 ? (
                  <ListEmptyMessage
                    message={t('pages.studio.noSearchResults', {
                      query: bundleSearch.trim(),
                    })}
                  />
                ) : (
                  <>
                    <div className="space-y-3">
                      {pagedBundles.items.map((b) => (
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
                      ))}
                    </div>
                    <PaginationControls
                      currentPage={pagedBundles.currentPage}
                      totalPages={pagedBundles.totalPages}
                      totalItems={filteredBundles.length}
                      pageSize={STUDIO_LIST_PAGE_SIZE}
                      onPageChange={setBundlePage}
                      formatNumber={formatNumber}
                      t={t}
                    />
                  </>
                )}
              </>
            )}
          </div>
        </section>

        {/* 我的知识技能 */}
        <section>
          <SectionTitle
            icon={Puzzle}
            title={t('pages.studio.ownSkillsTitle')}
            count={loading ? undefined : ownSkills.length}
            subtitle={t('pages.studio.ownSkillsSubtitle')}
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
                    {t('pages.studio.ownSkillsEmptyTitle')}
                  </p>
                  <p className="mt-1.5 max-w-[22rem] text-[12px] text-muted opacity-60">
                    {t('pages.studio.ownSkillsEmptyDescription')}
                  </p>
                  <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                    <Link
                      href="/studio/skills/new"
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-semibold text-white transition-opacity hover:opacity-90"
                    >
                      <Plus size={13} />
                      {t('pages.studio.newSkill')}
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
                      {t('pages.studio.importZip')}
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
              <>
                <ListSearch
                  value={skillSearch}
                  onChange={setSkillSearch}
                  placeholder={t('pages.studio.ownSkillsSearchPlaceholder')}
                />
                {filteredOwnSkills.length === 0 ? (
                  <ListEmptyMessage
                    message={t('pages.studio.noSearchResults', {
                      query: skillSearch.trim(),
                    })}
                  />
                ) : (
                  <>
                    <div className="space-y-3">
                      {pagedOwnSkills.items.map((sk) => (
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
                      ))}
                    </div>
                    <PaginationControls
                      currentPage={pagedOwnSkills.currentPage}
                      totalPages={pagedOwnSkills.totalPages}
                      totalItems={filteredOwnSkills.length}
                      pageSize={STUDIO_LIST_PAGE_SIZE}
                      onPageChange={setSkillPage}
                      formatNumber={formatNumber}
                      t={t}
                    />
                  </>
                )}
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

function ListSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative">
      <Search
        size={15}
        className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
      />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full h-10 pl-9 pr-3 rounded-xl border border-hairline bg-surface-card text-[13px] placeholder:text-muted focus:border-primary focus:outline-none transition-all"
      />
    </div>
  );
}

function ListEmptyMessage({ message }: { message: string }) {
  return (
    <div className="relative py-10 text-center rounded-2xl border border-dashed border-hairline overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,color-mix(in_srgb,var(--color-primary)_3%,transparent),transparent_70%)] pointer-events-none" />
      <div className="relative flex flex-col items-center gap-2">
        <Search size={18} className="text-muted/55" />
        <p className="text-[12px] text-muted opacity-70">{message}</p>
      </div>
    </div>
  );
}

function PaginationControls({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  formatNumber,
  t,
}: {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  formatNumber: (value: number) => string;
  t: (
    key: string,
    params?: Record<string, string | number | boolean | null | undefined>,
  ) => string;
}) {
  if (totalItems <= pageSize) return null;

  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalItems);

  return (
    <div className="flex flex-col items-center justify-between gap-2 rounded-2xl border border-hairline/60 bg-surface-card/60 px-3 py-2 sm:flex-row">
      <span className="text-[11px] text-muted tabular-nums">
        {t('pages.studio.paginationRange', {
          start: formatNumber(start),
          end: formatNumber(end),
          total: formatNumber(totalItems),
        })}
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage <= 1}
          className="inline-flex h-8 items-center gap-1 rounded-full px-3 text-[11px] text-muted transition-all hover:bg-surface-cream-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
        >
          <ChevronLeft size={13} />
          {t('pages.studio.previousPage')}
        </button>
        <span className="inline-flex h-8 min-w-14 items-center justify-center rounded-full bg-surface-cream-strong px-2 text-[11px] tabular-nums text-ink">
          {t('pages.studio.pageIndicator', {
            page: formatNumber(currentPage),
            total: formatNumber(totalPages),
          })}
        </span>
        <button
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage >= totalPages}
          className="inline-flex h-8 items-center gap-1 rounded-full px-3 text-[11px] text-muted transition-all hover:bg-surface-cream-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
        >
          {t('pages.studio.nextPage')}
          <ChevronRight size={13} />
        </button>
      </div>
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
    <div className="flex min-w-0 flex-1 items-start gap-3 sm:gap-4">
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
