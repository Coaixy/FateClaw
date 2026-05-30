'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { Layers, Puzzle, Users, Search } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { useSkillMarket } from '@/features/skills/hooks/use-skill-market';
import { formatCoins } from '@/lib/soft-currency';
import { useToast } from '@/lib/use-toast';

function getRankBadgeClass(rank: number): string {
  if (rank === 1) {
    return 'border-amber-400/40 bg-amber-500/15 text-amber-300';
  }
  if (rank === 2) {
    return 'border-slate-300/30 bg-slate-300/12 text-slate-200';
  }
  if (rank === 3) {
    return 'border-orange-400/35 bg-orange-500/12 text-orange-300';
  }
  return 'border-hairline bg-surface-cream-strong text-foreground-muted';
}

export default function DiscoverPage() {
  const { toast } = useToast();
  const notify = useCallback(
    (type: 'success' | 'error', message: string) => toast(type, message),
    [toast],
  );
  const market = useSkillMarket(notify);

  return (
    <AppShell>
      <div className="max-w-6xl mx-auto p-4 lg:p-10 space-y-4 lg:space-y-6">
        <header className="hidden lg:block">
          <h1 className="text-3xl font-bold tracking-tight">技能市场</h1>
          <p className="mt-1 text-sm text-foreground-muted">
            发现并订阅命理师发布的术数技能
          </p>
        </header>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted"
            />
          <input
              type="text"
              value={market.search}
              onChange={(e) => market.setSearch(e.target.value)}
              placeholder="搜索技能..."
              className="w-full h-10 pl-9 pr-3 rounded-xl border border-hairline bg-surface-card text-[13px] placeholder:text-foreground-muted focus:border-primary focus:outline-none transition-all"
            />
          </div>
        </div>

        {market.loading ? (
          <div className="py-16 text-center text-sm text-foreground-muted">
            加载中…
          </div>
        ) : market.filteredBundles.length + market.filteredSkills.length === 0 ? (
          <div className="py-16 text-center text-sm text-foreground-muted">
            暂无公开内容
          </div>
        ) : (
          <div className="space-y-3">
            {market.filteredBundles.length > 0 && (
              <div className="space-y-2.5">
                <div className="flex items-end justify-between gap-3 px-1">
                  <div>
                    <p className="text-[13px] font-semibold text-ink">
                      优先推荐 · 公开捆绑包
                    </p>
                    <p className="mt-1 text-[11px] text-foreground-muted">
                      一次订阅整组技能，适合直接整包使用
                    </p>
                  </div>
                  <span className="text-[10px] text-foreground-muted">
                    {market.filteredBundles.length} 个捆绑包
                  </span>
                </div>

                {market.filteredBundles.map((bundle, index) => {
                  const rank = index + 1;

                  return (
                    <Link
                      key={bundle.id}
                      href={`/skills/bundle/install?token=${bundle.bundle_token}`}
                      className="group flex items-center gap-3 rounded-2xl border border-hairline bg-surface-card px-3.5 py-3 hover:border-[color-mix(in_srgb,var(--color-primary)_40%,var(--color-hairline))] transition-all duration-200"
                    >
                      <div className="flex items-center gap-2 shrink-0">
                        <div
                          className={`flex h-10 w-10 items-center justify-center rounded-xl border text-[13px] font-bold tracking-tight ${getRankBadgeClass(rank)}`}
                        >
                          {rank}
                        </div>
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)]">
                          <Layers className="h-4 w-4 text-primary" />
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <h3 className="truncate text-[13px] font-semibold">
                            {bundle.name}
                          </h3>
                          <span className="shrink-0 rounded bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] px-1.5 py-0.5 text-[10px] leading-tight text-primary">
                            捆绑包
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-[12px] text-foreground-muted">
                          {bundle.description || '整组技能打包订阅'}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <span className="block text-[13px] font-bold text-ink">
                          一键订阅
                        </span>
                        <span className="mt-0.5 flex items-center justify-end gap-0.5 text-[10px] text-foreground-muted">
                          <Layers size={10} />
                          {bundle.skill_count} 个技能
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
                      技能热度榜
                    </p>
                    <p className="mt-1 text-[11px] text-foreground-muted">
                      默认按订阅热度排行，越靠前说明越受欢迎
                    </p>
                  </div>
                  <span className="text-[10px] text-foreground-muted">
                    {market.filteredSkills.length} 个技能
                  </span>
                </div>

                {market.filteredSkills.map((s, index) => {
                  const minPrice =
                    s.price_tiers.length > 0
                      ? Math.min(...s.price_tiers.map((t) => t.price_coins))
                      : 0;
                  const rank = index + 1;

                  return (
                    <Link
                      key={s.id}
                      href={
                        s.share_token
                          ? `/skills/install?token=${s.share_token}`
                          : '#'
                      }
                      className="group flex items-center gap-3 rounded-2xl border border-hairline bg-surface-card px-3.5 py-3 hover:border-[color-mix(in_srgb,var(--color-primary)_40%,var(--color-hairline))] transition-all duration-200"
                    >
                      <div className="flex items-center gap-2 shrink-0">
                        <div
                          className={`flex h-10 w-10 items-center justify-center rounded-xl border text-[13px] font-bold tracking-tight ${getRankBadgeClass(rank)}`}
                        >
                          {rank}
                        </div>
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)]">
                          <Puzzle className="h-4 w-4 text-primary" />
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <h3 className="truncate text-[13px] font-semibold">
                            {s.skill_name}
                          </h3>
                          <span className="shrink-0 rounded bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] px-1.5 py-0.5 text-[10px] leading-tight text-primary">
                            Skill
                          </span>
                          <span className="shrink-0 text-[10px] font-medium text-foreground-muted">
                            TOP {rank}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-[12px] text-foreground-muted">
                          {s.description || '暂无描述'}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <span className="block text-[13px] font-bold text-ink">
                          {minPrice > 0
                            ? formatCoins(minPrice)
                            : '免费'}
                        </span>
                        <span className="mt-0.5 flex items-center justify-end gap-0.5 text-[10px] text-foreground-muted">
                          <Users size={10} />
                          热度 {s.stat_subscriber_count.toLocaleString()}
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
