'use client';

import { Loader2, Trash2 } from 'lucide-react';

import type { ResetItem, ResetScope } from '@/components/settings/data-management/data-management-types';

export function DataManagementItem({
  item,
  resettingScope,
  onReset,
}: {
  item: ResetItem;
  resettingScope: ResetScope | null;
  onReset: (scope: ResetScope) => void;
}) {
  const Icon = item.icon;

  return (
    <div className="relative flex items-center justify-between px-4 py-2.5 hover:bg-surface-cream-strong/50 transition-colors">
      <div className="flex items-center gap-2.5 min-w-0">
        <Icon size={14} className="text-muted/60 shrink-0" />
        <div className="min-w-0">
          <p className="text-[12px] font-medium">{item.label}</p>
          <p className="text-[10px] text-muted">{item.desc}</p>
        </div>
      </div>
      <button
        onClick={() => onReset(item.scope)}
        disabled={resettingScope !== null}
        className="flex items-center gap-1 h-6 px-2 rounded-md text-[11px] font-medium text-muted hover:text-red-400 border border-transparent hover:border-red-500/20 hover:bg-red-500/5 disabled:opacity-30 transition-all duration-150 cursor-pointer shrink-0 ml-3"
      >
        {resettingScope === item.scope ? (
          <Loader2 size={11} className="animate-spin" />
        ) : (
          <Trash2 size={11} />
        )}
        清除
      </button>
    </div>
  );
}
