'use client';

import { Loader2, RotateCcw } from 'lucide-react';

import type { ResetScope } from '@/components/settings/data-management/data-management-types';

export function DataManagementResetAll({
  resettingScope,
  onReset,
  resetLabel,
  title,
  description,
}: {
  resettingScope: ResetScope | null;
  onReset: (scope: ResetScope) => void;
  resetLabel: string;
  title: string;
  description: string;
}) {
  return (
    <div className="relative flex items-center justify-between px-4 py-2.5 border-t border-red-500/10">
      <div className="flex items-center gap-2.5 min-w-0">
        <RotateCcw size={14} className="text-red-500/60 shrink-0" />
        <div className="min-w-0">
          <p className="text-[12px] font-medium text-red-400">{title}</p>
          <p className="text-[10px] text-muted">{description}</p>
        </div>
      </div>
      <button
        onClick={() => onReset('all')}
        disabled={resettingScope !== null}
        className="flex items-center gap-1 h-6 px-2.5 rounded-md text-[11px] font-medium text-red-400 border border-red-500/20 hover:bg-red-500/10 hover:border-red-500/30 disabled:opacity-30 transition-all duration-150 cursor-pointer shrink-0 ml-3"
      >
        {resettingScope === 'all' ? (
          <Loader2 size={11} className="animate-spin" />
        ) : (
          <RotateCcw size={11} />
        )}
        {resetLabel}
      </button>
    </div>
  );
}
