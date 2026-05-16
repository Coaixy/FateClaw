'use client';

export function SkillSkeleton() {
  return (
    <div className="rounded-2xl border border-hairline bg-surface-card p-5 animate-pulse">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-surface-cream-strong" />
        <div className="flex-1 pt-0.5">
          <div className="h-4 w-28 rounded-lg bg-surface-cream-strong mb-2.5" />
          <div className="h-3 w-40 rounded-lg bg-surface-cream-strong" />
        </div>
      </div>
      <div className="flex gap-2 mt-5 pt-3 border-t border-hairline/50">
        <div className="h-6 w-14 rounded-md bg-surface-cream-strong" />
        <div className="h-6 w-16 rounded-md bg-surface-cream-strong" />
      </div>
    </div>
  );
}
