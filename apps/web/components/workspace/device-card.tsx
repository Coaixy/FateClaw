'use client';

import {
  ChevronDown,
  Circle,
  Loader2,
  Save,
  Smartphone,
  Sparkles,
  Trash2,
} from 'lucide-react';

import type { Account } from '@/features/accounts/api';
import type { SoulPreset } from '@/lib/soul-presets';

export function DeviceCard({
  account,
  expanded,
  soulContent,
  soulLoading,
  soulSaving,
  soulDirty,
  soulPresets,
  onToggle,
  onRemove,
  onOpenPreset,
  onSoulChange,
  onSaveSoul,
}: {
  account: Account;
  expanded: boolean;
  soulContent: string;
  soulLoading: boolean;
  soulSaving: boolean;
  soulDirty: boolean;
  soulPresets: readonly SoulPreset[];
  onToggle: () => void;
  onRemove: () => void;
  onOpenPreset: (preset: SoulPreset) => void;
  onSoulChange: (value: string) => void;
  onSaveSoul: () => void;
}) {
  return (
    <div className="rounded-2xl border border-hairline/50 bg-[color-mix(in_srgb,var(--color-surface-card)_60%,transparent)] backdrop-blur-xl overflow-hidden hover:border-hairline transition-colors">
      <div
        className="flex items-center justify-between px-4 py-3.5 cursor-pointer hover:bg-[color-mix(in_srgb,var(--color-surface-cream-strong)_40%,transparent)] transition-colors"
        onClick={onToggle}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="relative shrink-0">
            <div
              className={`w-11 h-11 rounded-xl flex items-center justify-center border ${
                account.enabled
                  ? 'bg-[color-mix(in_srgb,var(--color-success)_10%,transparent)] border-[color-mix(in_srgb,var(--color-success)_20%,transparent)]'
                  : 'bg-surface-card border-hairline'
              }`}
            >
              <Smartphone
                size={18}
                className={
                  account.enabled
                    ? 'text-success'
                    : 'text-muted'
                }
              />
            </div>
            <Circle
              size={10}
              fill={account.enabled ? 'var(--color-success)' : '#ef4444'}
              className={`absolute -bottom-0.5 -right-0.5 ring-2 ring-surface-card rounded-full ${
                account.enabled ? 'text-success' : 'text-red-500'
              }`}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <p className="text-[14px] font-bold truncate leading-tight">
                {account.name}
              </p>
              <span
                className={`shrink-0 whitespace-nowrap text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                  account.enabled
                    ? 'text-success bg-success/10 border-success/20'
                    : 'text-red-400 bg-red-500/10 border-red-500/20'
                }`}
              >
                {account.enabled ? 'Online' : 'Offline'}
              </span>
            </div>
            <p className="text-[11px] text-muted font-mono truncate whitespace-nowrap mt-0.5">
              {account.id} · 接入于{' '}
              {new Date(account.created_at).toLocaleDateString('zh-CN')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          <button
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer"
            aria-label="解绑"
          >
            <Trash2 size={14} />
          </button>
          <div
            className={`w-8 h-8 flex items-center justify-center rounded-lg transition-transform duration-300 ${
              expanded
                ? 'rotate-180 bg-surface-card'
                : 'text-muted'
            }`}
          >
            <ChevronDown size={14} />
          </div>
        </div>
      </div>

      <div
        className={`overflow-hidden transition-all duration-300 ease-in-out ${
          expanded
            ? 'max-h-[800px] opacity-100 border-t border-hairline/50'
            : 'max-h-0 opacity-0'
        }`}
      >
        <div className="p-4 bg-[color-mix(in_srgb,var(--color-surface-card)_30%,transparent)]">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
            <div className="min-w-0">
              <p className="text-[13px] font-bold flex min-w-0 items-center gap-1.5">
                <Sparkles size={13} className="text-primary" />
                <span className="truncate">灵魂记忆 (Soul Inject)</span>
              </p>
              <p className="text-[11px] text-muted mt-0.5 font-medium truncate">
                配置全局 System Prompt 与基础人设认知
              </p>
            </div>
            <button
              onClick={onSaveSoul}
              disabled={!soulDirty || soulSaving}
              className={`flex shrink-0 items-center justify-center gap-1.5 h-8 px-4 rounded-lg text-[12px] font-bold whitespace-nowrap transition-colors duration-200 cursor-pointer ${
                !soulDirty || soulSaving
                  ? 'bg-surface-card border border-hairline/50 text-muted opacity-50 cursor-not-allowed'
                  : 'bg-primary text-black hover:opacity-90'
              }`}
            >
              {soulSaving ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Save size={13} />
              )}
              部署至运行时
            </button>
          </div>

          <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1.5 pt-0.5 px-0.5 scrollbar-hide -mx-0.5">
            {soulPresets.map((preset) => (
              <button
                key={preset.id}
                onClick={() => onOpenPreset(preset)}
                className="shrink-0 flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[12px] font-medium border border-hairline/50 bg-surface-card/50 text-muted hover:text-ink hover:border-hairline hover:bg-surface-cream-strong transition-colors duration-200 cursor-pointer"
              >
                <span className="text-[13px]">{preset.icon}</span>
                {preset.name}
              </button>
            ))}
          </div>

          <div className="relative">
            {soulLoading ? (
              <div className="h-[220px] rounded-xl bg-surface-card/50 border border-hairline/50 animate-pulse" />
            ) : (
              <>
                <textarea
                  value={soulContent}
                  onChange={(event) => onSoulChange(event.target.value)}
                  className="w-full h-[220px] rounded-xl bg-surface-card/70 border border-hairline px-3.5 py-3 text-[12px] font-mono leading-[1.7] text-ink resize-y focus:outline-none focus:border-primary/60 focus:bg-surface-card/90 transition-colors custom-scrollbar"
                  placeholder="暂无配置，输入 System Prompt 或从上方选择预设..."
                  spellCheck={false}
                />
                <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded-md bg-canvas/80 border border-hairline/60 text-[10px] font-mono text-muted pointer-events-none">
                  markdown
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
