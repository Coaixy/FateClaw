'use client';

import { Search } from 'lucide-react';

import type { SkillFilter } from '@/components/settings/system-skills/system-skills-types';

export function SystemSkillsToolbar({
  totalCount,
  enabledCount,
  filter,
  search,
  onFilterChange,
  onSearchChange,
}: {
  totalCount: number;
  enabledCount: number;
  filter: SkillFilter;
  search: string;
  onFilterChange: (filter: SkillFilter) => void;
  onSearchChange: (value: string) => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-[13px] shrink-0">
          <span className="text-muted">
            共{' '}
            <span className="text-ink font-semibold tabular-nums">
              {totalCount}
            </span>{' '}
            个
          </span>
          <span className="w-px h-3.5 bg-hairline" />
          <span className="text-muted">
            启用{' '}
            <span className="text-primary font-semibold tabular-nums">
              {enabledCount}
            </span>
          </span>
        </div>

        <div className="flex rounded-xl bg-surface-card border border-hairline overflow-hidden shrink-0">
          {(
            [
              ['all', '全部'],
              ['enabled', '启用'],
              ['disabled', '未启用'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => onFilterChange(value)}
              className={`h-8 px-3.5 text-[12px] font-medium transition-all cursor-pointer ${
                filter === value
                  ? 'bg-surface-cream-strong text-ink'
                  : 'text-muted hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative">
        <Search
          size={15}
          className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
        />
        <input
          type="text"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="搜索技能..."
          className="w-full h-10 pl-10 pr-3 rounded-xl border border-hairline bg-canvas text-[13px] placeholder:text-muted focus:border-primary focus:ring-1 focus:ring-primary/20 focus:outline-none transition-all"
        />
      </div>
    </>
  );
}
