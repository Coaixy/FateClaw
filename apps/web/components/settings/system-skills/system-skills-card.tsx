'use client';

import {
  ChevronDown,
  Lock,
  MessageSquare,
  Sparkles,
} from 'lucide-react';

import type { Skill } from '@/features/skills/api';

export function SystemSkillsCard({
  skill,
  expanded,
  onToggleExpanded,
  onToggleEnabled,
}: {
  skill: Skill;
  expanded: boolean;
  onToggleExpanded: () => void;
  onToggleEnabled: () => void;
}) {
  return (
    <div
      className={`group relative rounded-2xl border bg-surface-card transition-all duration-300 ${
        expanded
          ? 'border-[color-mix(in_srgb,var(--color-primary)_30%,var(--color-hairline))] shadow-[0_0_20px_color-mix(in_srgb,var(--color-primary)_4%,transparent)]'
          : 'border-hairline hover:border-[color-mix(in_srgb,var(--color-primary)_20%,var(--color-hairline))]'
      }`}
    >
      <div className="absolute inset-0 rounded-2xl bg-[radial-gradient(ellipse_at_center,color-mix(in_srgb,var(--color-primary)_4%,transparent),transparent_70%)] opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />

      <div
        className="relative flex items-center gap-3 px-4 sm:px-5 py-4 cursor-pointer"
        onClick={onToggleExpanded}
      >
        <div
          className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-all duration-300 ${
            skill.enabled
              ? 'bg-[color-mix(in_srgb,var(--color-primary)_15%,transparent)]'
              : 'bg-surface-cream-strong'
          }`}
        >
          <Sparkles
            size={14}
            className={`transition-colors duration-300 ${
              skill.enabled
                ? 'text-primary'
                : 'text-muted'
            }`}
          />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold truncate tracking-tight">
            {skill.name}
          </p>
        </div>

        {skill.userControllable ? (
          <button
            onClick={(event) => {
              event.stopPropagation();
              onToggleEnabled();
            }}
            className={`shrink-0 relative w-10 h-[22px] rounded-full transition-colors cursor-pointer ${
              skill.enabled
                ? 'bg-primary'
                : 'bg-surface-cream-strong border border-hairline'
            }`}
            title={skill.enabled ? '点击禁用' : '点击启用'}
          >
            <span
              className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-transform ${
                skill.enabled ? 'left-[calc(100%-19px)]' : 'left-[3px]'
              }`}
            />
          </button>
        ) : (
          <span className="shrink-0 inline-flex items-center h-6 px-2 rounded-md text-[11px] font-medium bg-surface-cream-strong text-muted">
            <Lock size={10} className="mr-1" />
            管理员已禁用
          </span>
        )}

        <ChevronDown
          size={14}
          className={`text-muted transition-transform duration-300 shrink-0 ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </div>

      {expanded && (
        <div className="relative px-4 sm:px-5 pb-5 border-t border-hairline/50">
          <p className="text-[13px] text-muted leading-relaxed mt-4 mb-3">
            {skill.description}
          </p>

          {skill.defaultEnabled === false && (
            <p className="text-[11px] text-muted mb-3 opacity-60">
              此技能默认关闭，需手动开启
            </p>
          )}

          {skill.trigger && (
            <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-[color-mix(in_srgb,var(--color-canvas)_60%,var(--color-surface-card))] border border-hairline/30">
              <MessageSquare
                size={12}
                className="text-muted shrink-0 mt-0.5"
              />
              <p className="text-[12px] text-muted leading-relaxed">
                {skill.trigger}
              </p>
            </div>
          )}

        </div>
      )}
    </div>
  );
}
