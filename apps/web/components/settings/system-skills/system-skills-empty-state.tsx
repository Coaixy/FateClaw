'use client';

import { Sparkles } from 'lucide-react';

export function SystemSkillsEmptyState() {
  return (
    <div className="relative py-16 text-center rounded-2xl border border-dashed border-hairline overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,color-mix(in_srgb,var(--color-primary)_3%,transparent),transparent_70%)] pointer-events-none" />
      <div className="relative">
        <div className="w-14 h-14 rounded-2xl bg-surface-card border border-hairline flex items-center justify-center mx-auto mb-4">
          <Sparkles size={20} className="text-muted" />
        </div>
        <p className="text-[14px] text-muted font-medium">暂无可用技能</p>
        <p className="text-[12px] text-muted mt-1.5 opacity-50">
          技能会在系统更新后自动出现
        </p>
      </div>
    </div>
  );
}
