'use client';

import { Share2, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';

import { SubscribedSkill } from '@/features/skills/api';

export function SubscribedSkillCard({
  sk,
  onToggle,
  onUnsubscribe,
}: {
  sk: SubscribedSkill;
  onToggle: (id: string) => void;
  onUnsubscribe: (id: string) => void;
}) {
  return (
    <div className="group relative rounded-2xl border border-hairline bg-surface-card hover:border-[color-mix(in_srgb,#3b82f6_30%,var(--color-hairline))] transition-all duration-300">
      <div className="absolute inset-0 rounded-2xl bg-[radial-gradient(ellipse_at_center,rgb(59_130_246/0.04),transparent_70%)] opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />

      <div className="relative p-3.5 sm:p-4">
        <div className="flex items-start gap-3">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all duration-300 ${
              sk.subscription_enabled
                ? 'bg-blue-500/12 shadow-[0_0_12px_rgb(59_130_246/0.08)]'
                : 'bg-surface-cream-strong'
            }`}
          >
            <Share2
              size={16}
              className={`transition-colors duration-300 ${
                sk.subscription_enabled
                  ? 'text-blue-400'
                  : 'text-muted'
              }`}
            />
          </div>

          <div className="flex-1 min-w-0 pt-0.5">
            <p className="text-[13px] font-semibold truncate tracking-tight">
              {sk.skill_name}
            </p>
            {sk.description && (
              <p className="text-[12px] text-muted mt-1 line-clamp-2 leading-relaxed">
                {sk.description}
              </p>
            )}
          </div>

          <button
            onClick={() => onToggle(sk.subscription_id)}
            className="shrink-0 p-1.5 rounded-xl hover:bg-surface-cream-strong transition-all cursor-pointer"
            title={sk.subscription_enabled ? '禁用' : '启用'}
            aria-label={sk.subscription_enabled ? '禁用' : '启用'}
          >
            {sk.subscription_enabled ? (
              <ToggleRight size={24} className="text-blue-400" />
            ) : (
              <ToggleLeft size={24} className="text-muted" />
            )}
          </button>
        </div>

        <div className="flex items-center justify-between mt-4 pt-3 border-t border-hairline/50">
          <div className="flex items-center gap-2 overflow-hidden">
            <span
              className={`shrink-0 inline-flex items-center h-6 px-2 rounded-md text-[11px] font-medium ${
                sk.subscription_enabled
                  ? 'bg-blue-500/10 text-blue-400'
                  : 'bg-surface-cream-strong text-muted'
              }`}
            >
              {sk.subscription_enabled ? '已启用' : '未启用'}
            </span>
            <span className="shrink-0 inline-flex items-center h-6 px-2 rounded-md text-[11px] bg-surface-cream-strong text-muted truncate max-w-[140px]">
              {sk.author_label}
            </span>
            <span className="shrink-0 inline-flex items-center h-6 px-2 rounded-md text-[11px] bg-surface-cream-strong text-muted tabular-nums">
              {sk.content_length.toLocaleString()} 字
            </span>
          </div>

          <button
            onClick={() => onUnsubscribe(sk.subscription_id)}
            className="shrink-0 h-7 w-7 rounded-lg flex items-center justify-center text-muted hover:text-red-400 hover:bg-red-500/10 transition-all cursor-pointer ml-2"
            title="取消订阅"
            aria-label="取消订阅"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
