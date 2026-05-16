'use client';

import { Sparkles } from 'lucide-react';

import { BottomSheet } from '@/components/ui/bottom-sheet';
import type { SoulPreset } from '@/lib/soul-presets';

export function SoulPresetSheet({
  preset,
  onClose,
  onApply,
}: {
  preset: SoulPreset | null;
  onClose: () => void;
  onApply: () => void;
}) {
  if (!preset) return null;

  return (
    <BottomSheet
      open
      onClose={onClose}
      variant="sheet"
      size="md"
      zIndex={110}
      title={
        <span className="inline-flex items-center gap-3 min-w-0">
          <span className="w-9 h-9 rounded-xl bg-[color-mix(in_srgb,var(--color-primary)_15%,transparent)] border border-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] flex items-center justify-center text-lg shrink-0">
            {preset.icon}
          </span>
          <span className="min-w-0">
            <span className="block text-[15px] font-extrabold tracking-tight truncate">
              {preset.name}
            </span>
            <span className="block text-[11px] font-medium text-muted truncate">
              {preset.tagline}
            </span>
          </span>
        </span>
      }
      footer={
        <div className="flex items-center justify-end gap-2.5 px-4 sm:px-6 py-3 sm:py-4">
          <button
            onClick={onClose}
            className="h-10 px-5 rounded-xl text-[13px] font-bold border border-hairline bg-surface-card text-muted hover:text-ink hover:bg-surface-cream-strong transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            onClick={onApply}
            className="flex items-center gap-1.5 h-10 px-6 rounded-xl text-[13px] font-bold bg-primary text-black active:opacity-80 sm:hover:shadow-[0_0_20px_color-mix(in_srgb,var(--color-primary)_40%,transparent)] transition-all duration-200 cursor-pointer"
          >
            <Sparkles size={14} />
            载入此配置
          </button>
        </div>
      }
    >
      <div className="p-4 sm:p-6">
        <div className="rounded-xl bg-[#09090b] border border-hairline/80 p-4 sm:p-5 shadow-inner">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-2 h-2 rounded-full bg-red-500/50" />
            <div className="w-2 h-2 rounded-full bg-yellow-500/50" />
            <div className="w-2 h-2 rounded-full bg-green-500/50" />
            <span className="text-[10px] font-mono text-muted ml-2">
              system_prompt.md
            </span>
          </div>
          <pre className="text-[13px] font-mono leading-[1.7] text-muted whitespace-pre-wrap break-words selection:bg-primary selection:text-black">
            {preset.content}
          </pre>
        </div>
      </div>
    </BottomSheet>
  );
}
