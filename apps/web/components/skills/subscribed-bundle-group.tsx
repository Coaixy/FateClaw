'use client';

import { Layers, Trash2 } from 'lucide-react';

import type { SkillSubscriptionGroup } from '@/features/skills/subscription-groups';

export function SubscribedBundleGroup({
  group,
  onUnsubscribeBundle,
}: {
  group: SkillSubscriptionGroup;
  onUnsubscribeBundle: (bundleId: string) => void;
}) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-hairline bg-surface-card hover:border-[color-mix(in_srgb,#3b82f6_30%,var(--color-hairline))] transition-all duration-300">
      <div className="absolute inset-0 rounded-2xl bg-[radial-gradient(ellipse_at_center,rgb(59_130_246/0.04),transparent_70%)] opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />

      <div className="relative p-3.5 sm:p-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-blue-500/12 shadow-[0_0_12px_rgb(59_130_246/0.08)]">
            <Layers size={16} className="text-blue-400" />
          </div>

          <div className="flex-1 min-w-0 pt-0.5">
            <p className="text-[13px] font-semibold truncate tracking-tight">
              {group.bundleName}
            </p>
            <p className="text-[12px] text-muted mt-1">
              {group.skills.length} 个技能通过这个捆绑包订阅
            </p>
          </div>

          <button
            onClick={() => onUnsubscribeBundle(group.bundleId)}
            className="shrink-0 h-8 px-2.5 rounded-lg inline-flex items-center justify-center gap-1.5 text-[11px] font-medium text-red-400 bg-red-500/10 hover:bg-red-500/15 transition-all cursor-pointer"
            title="取消整个捆绑包订阅"
            aria-label="取消整个捆绑包订阅"
          >
            <Trash2 size={13} />
            整包取消
          </button>
        </div>

        <div className="mt-4 min-w-0 overflow-hidden pt-3 border-t border-hairline/50">
          <div className="grid min-w-0 gap-2">
            {group.skills.map((sk) => (
              <div
                key={`${group.bundleId}-${sk.subscription_id}`}
                className="flex min-w-0 items-center gap-2 text-[12px] text-muted"
              >
                <span className="inline-flex h-5 max-w-[45%] shrink-0 items-center rounded-md bg-surface-cream-strong px-2 text-ink sm:max-w-[220px]">
                  <span className="min-w-0 truncate">{sk.skill_name}</span>
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {sk.description || '无简介'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
