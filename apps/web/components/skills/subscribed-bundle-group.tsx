'use client';

import { Layers, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';

import type { SkillSubscriptionGroup } from '@/features/skills/subscription-groups';
import { useI18n } from '@/lib/i18n';

export function SubscribedBundleGroup({
  group,
  onToggle,
  onUnsubscribeBundle,
}: {
  group: SkillSubscriptionGroup;
  onToggle: (subscriptionId: string) => void;
  onUnsubscribeBundle: (bundleId: string) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-hairline bg-surface-raised hover:border-primary/40 transition-all duration-300">
      <div className="relative p-3.5 sm:p-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-primary/15">
            <Layers size={16} className="text-primary" />
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
            className="shrink-0 h-8 px-2.5 rounded-lg inline-flex items-center justify-center gap-1.5 text-[11px] font-medium text-error bg-error/10 hover:bg-error/15 transition-all cursor-pointer"
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
                <button
                  type="button"
                  onClick={() => onToggle(sk.subscription_id)}
                  className="shrink-0 rounded-xl p-2 transition-colors hover:bg-surface-cream-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  title={t(
                    sk.subscription_enabled
                      ? 'pages.studio.disableSkill'
                      : 'pages.studio.enableSkill',
                  )}
                  aria-label={`${t(sk.subscription_enabled ? 'pages.studio.disableSkill' : 'pages.studio.enableSkill')}：${sk.skill_name}`}
                >
                  {sk.subscription_enabled ? (
                    <ToggleRight size={24} className="text-primary" />
                  ) : (
                    <ToggleLeft size={24} className="text-muted" />
                  )}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
