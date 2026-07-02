'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Layers, Puzzle, Users, Search } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { useSkillMarket } from '@/features/skills/hooks/use-skill-market';
import { useI18n } from '@/lib/i18n';
import { appendGuideResume, buildGuideReturnQuery } from '@/lib/return-to';
import { useToast } from '@/lib/use-toast';

function appendQueryString(href: string, query: string) {
  if (!query) return href;
  return `${href}${href.includes('?') ? '&' : '?'}${query}`;
}

const DISCOVER_RETURN_QUERY = new URLSearchParams({
  returnTo: '/discover',
}).toString();

export default function DiscoverPage() {
  const { toast } = useToast();
  const { formatNumber, t } = useI18n();
  const [guideReturnQuery, setGuideReturnQuery] = useState('');
  const [guideReturnHref, setGuideReturnHref] = useState<string | null>(null);
  const notify = useCallback(
    (type: 'success' | 'error', message: string) => toast(type, message),
    [toast],
  );
  const market = useSkillMarket(notify);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('guide') !== 'resume') {
      setGuideReturnQuery('');
      setGuideReturnHref(null);
      return;
    }

    const returnTo = params.get('returnTo') ?? '/ai-chat';
    setGuideReturnQuery(buildGuideReturnQuery(returnTo));
    setGuideReturnHref(appendGuideResume(returnTo));
  }, []);

  // 捆绑包不分类：选中具体分类时只看技能区，隐藏捆绑包区，避免分类语义错位。
  const visibleBundles =
    market.category === '' ? market.filteredBundles : [];

  return (
    <AppShell requireAuth={false}>
      <div className="max-w-6xl mx-auto p-4 lg:p-10 space-y-4 lg:space-y-6">
        <header className="flex flex-col gap-3 px-0.5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-ink sm:text-2xl lg:text-3xl">
              {t('pages.discover.title')}
            </h1>
            <p className="mt-1 text-[12px] text-muted sm:text-sm">
              {t('pages.discover.description')}
            </p>
          </div>
          {guideReturnHref && (
            <Link
              href={guideReturnHref}
              className="inline-flex h-10 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 px-3 text-[12px] font-medium text-primary transition-colors hover:border-primary/40 hover:bg-primary/15"
            >
              {t('pages.common.returnAiChatGuide')}
            </Link>
          )}
        </header>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
            />
          <input
              type="text"
              value={market.search}
              onChange={(e) => market.setSearch(e.target.value)}
              placeholder={t('pages.discover.searchPlaceholder')}
              className="w-full h-10 pl-9 pr-3 rounded-xl border border-hairline bg-surface-card text-[13px] placeholder:text-muted focus:border-primary focus:outline-none transition-all"
            />
          </div>
        </div>

        {/* 用途分类筛选：仅在结果集中出现过的分类才展示，避免点了没结果的空 chip。 */}
        {market.availableCategories.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 -mx-0.5 px-0.5">
            <button
              type="button"
              onClick={() => market.setCategory('')}
              className={`shrink-0 h-8 rounded-full border px-3 text-[12px] font-medium transition-colors ${
                market.category === ''
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-hairline bg-surface-card text-muted hover:border-primary/40'
              }`}
            >
              {t('pages.discover.categoryAll')}
            </button>
            {market.availableCategories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => market.setCategory(cat)}
                className={`shrink-0 h-8 rounded-full border px-3 text-[12px] font-medium transition-colors ${
                  market.category === cat
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-hairline bg-surface-card text-muted hover:border-primary/40'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        {market.loading ? (
          <div className="py-16 text-center text-sm text-muted">
            {t('common.loading')}…
          </div>
        ) : visibleBundles.length + market.filteredSkills.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted">
            {t('pages.discover.empty')}
          </div>
        ) : (
          <div className="space-y-3">
            {visibleBundles.length > 0 && (
              <div className="space-y-2.5">
                <div className="flex items-end justify-between gap-3 px-1">
                  <div>
                    <p className="text-[13px] font-semibold text-ink">
                      {t('pages.discover.bundlesTitle')}
                    </p>
                    <p className="mt-1 text-[11px] text-muted">
                      {t('pages.discover.bundlesDescription')}
                    </p>
                  </div>
                  <span className="text-[10px] text-muted">
                    {t('pages.common.countBundles', {
                      count: formatNumber(visibleBundles.length),
                    })}
                  </span>
                </div>

                {visibleBundles.map((bundle) => {
                  return (
                    <Link
                      key={bundle.id}
                      href={appendQueryString(
                        `/skills/bundle/install?token=${bundle.bundle_token}`,
                        guideReturnQuery || DISCOVER_RETURN_QUERY,
                      )}
                      className="group flex items-start gap-3 rounded-2xl border border-hairline bg-surface-raised px-3.5 py-3 hover:border-[color-mix(in_srgb,var(--color-primary)_40%,var(--color-hairline))] transition-all duration-200 sm:items-center"
                    >
                      <div className="flex items-center gap-2 shrink-0">
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)]">
                          <Layers className="h-4 w-4 text-primary" />
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <h3 className="min-w-0 basis-full truncate text-[13px] font-semibold sm:basis-auto">
                            {bundle.name}
                          </h3>
                          <span className="shrink-0 rounded bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] px-1.5 py-0.5 text-[10px] leading-tight text-primary">
                            {t('pages.discover.bundleBadge')}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-[12px] text-muted">
                          {bundle.description ||
                            t('pages.discover.bundleFallbackDescription')}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] sm:hidden">
                          <span className="font-bold text-ink">
                            {t('pages.discover.subscribeAll')}
                          </span>
                          <span className="inline-flex items-center gap-1 rounded-md border border-hairline/60 bg-canvas px-1.5 py-0.5 font-medium text-body-strong">
                            <Layers size={11} className="text-muted" />
                            {t('pages.common.countSkills', {
                              count: formatNumber(bundle.skill_count),
                            })}
                          </span>
                        </div>
                      </div>
                      <div className="hidden shrink-0 text-right sm:block">
                        <span className="block text-[13px] font-bold text-ink">
                          {t('pages.discover.subscribeAll')}
                        </span>
                        <span className="mt-0.5 flex items-center justify-end gap-0.5 text-[10px] text-muted">
                          <Layers size={10} />
                          {t('pages.common.countSkills', {
                            count: formatNumber(bundle.skill_count),
                          })}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}

            {market.filteredSkills.length > 0 && (
              <div className="space-y-2.5">
                <div className="flex items-end justify-between gap-3 px-1">
                  <div>
                    <p className="text-[13px] font-semibold text-ink">
                      {t('pages.discover.skillsTitle')}
                    </p>
                    <p className="mt-1 text-[11px] text-muted">
                      {t('pages.discover.skillsDescription')}
                    </p>
                  </div>
                  <span className="text-[10px] text-muted">
                    {t('pages.common.countSkills', {
                      count: formatNumber(market.filteredSkills.length),
                    })}
                  </span>
                </div>

                {market.filteredSkills.map((s) => {
                  return (
                    <Link
                      key={s.id}
                      href={
                        s.share_token
                          ? appendQueryString(
                              `/skills/install?token=${s.share_token}`,
                              guideReturnQuery || DISCOVER_RETURN_QUERY,
                            )
                          : '#'
                      }
                      className="group flex min-h-[76px] items-start gap-3 rounded-2xl border border-hairline bg-surface-raised px-3.5 py-3 hover:border-[color-mix(in_srgb,var(--color-primary)_40%,var(--color-hairline))] transition-all duration-200 sm:items-center"
                    >
                      <div className="flex items-center gap-2 shrink-0">
                        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--color-primary)_14%,transparent)]">
                          <Puzzle className="h-4 w-4 text-primary" />
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <h3 className="min-w-0 basis-full truncate text-[14px] font-semibold text-ink sm:basis-auto">
                            {s.skill_name}
                          </h3>
                          <span className="shrink-0 rounded bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold leading-tight text-primary">
                            {t('pages.discover.skillBadge')}
                          </span>
                          {/* 分类标签：'通用' 为未归类兜底，不展示以免干扰。 */}
                          {s.category && s.category !== '通用' && (
                            <span className="shrink-0 rounded border border-hairline/60 bg-canvas px-1.5 py-0.5 text-[10px] leading-tight text-body-strong">
                              {s.category}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 truncate text-[12px] leading-5 text-body">
                          {s.description || t('pages.discover.noDescription')}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] sm:hidden">
                          <span className="inline-flex items-center gap-1 rounded-md border border-hairline/60 bg-canvas px-1.5 py-0.5 font-medium text-body-strong">
                            <Users size={11} className="text-muted" />
                            {t('pages.discover.subscriberCount', {
                              count: formatNumber(s.stat_subscriber_count),
                            })}
                          </span>
                        </div>
                      </div>
                      <div className="hidden min-w-[72px] shrink-0 text-right sm:block">
                        <span className="block text-[14px] font-bold text-ink">
                          {t('pages.discover.subscribe')}
                        </span>
                        <span className="mt-1 inline-flex items-center justify-end gap-1 rounded-md border border-hairline/60 bg-canvas px-1.5 py-0.5 text-[11px] font-medium text-body-strong whitespace-nowrap">
                          <Users size={11} className="text-muted" />
                          {t('pages.discover.subscriberCount', {
                            count: formatNumber(s.stat_subscriber_count),
                          })}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
