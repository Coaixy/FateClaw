'use client';

import {
  ChevronRight,
  ClipboardPaste,
  Loader2,
  Share2,
  Sparkles,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { PaipanCatalogItem } from '@/features/paipan/api';

export interface EnabledSkillSummary {
  id: string;
  name: string;
  source: 'own' | 'subscribed';
}

interface PaipanSkillRailProps {
  catalog: PaipanCatalogItem[];
  loading: boolean;
  enabledSkills?: EnabledSkillSummary[];
  enabledSkillsLoading?: boolean;
  disabled?: boolean;
  pastedBoardDisabled?: boolean;
  onSelectSkill: (skill: string) => void;
  onOpenAll: () => void;
  onOpenPastedBoard: () => void;
}

function LoadingCard() {
  return (
    <div className="min-w-[108px] rounded-xl border border-hairline bg-surface-card/60 px-2.5 py-2 sm:min-w-[120px]">
      <div className="flex items-center justify-between gap-2">
        <div className="h-5 w-5 rounded-full bg-hairline/60" />
        <div className="h-3 w-3 rounded-full bg-hairline/50" />
      </div>
      <div className="mt-2.5 h-3.5 w-14 rounded-full bg-hairline/45" />
    </div>
  );
}

export function PaipanSkillRail({
  catalog,
  loading,
  enabledSkills = [],
  enabledSkillsLoading = false,
  disabled = false,
  pastedBoardDisabled,
  onSelectSkill,
  onOpenAll,
  onOpenPastedBoard,
}: PaipanSkillRailProps) {
  const isEmpty = !loading && catalog.length === 0;
  const hasEnabledSkills = enabledSkills.length > 0;

  return (
    <section className="rounded-2xl border border-hairline bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01))] px-2.5 py-2.5 sm:px-3">
      <div className="flex items-center justify-between gap-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/12 text-primary">
              <Sparkles size={14} />
            </div>
            <div>
              <p className="text-[12px] sm:text-[13px] font-semibold tracking-tight text-ink">
                手动排盘
              </p>
              <p className="text-[9px] text-muted">
                也可以直接发消息对话
              </p>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            onClick={onOpenPastedBoard}
            disabled={pastedBoardDisabled ?? disabled}
            icon={<ClipboardPaste size={13} />}
            className="h-8 rounded-lg px-2.5"
          >
            自贴盘面
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={onOpenAll}
            disabled={disabled || loading || isEmpty}
            className="h-8 rounded-lg px-3"
          >
            更多术数
          </Button>
        </div>
      </div>

      <div className="mt-2">
        {isEmpty ? (
          <div className="rounded-xl border border-dashed border-hairline bg-surface-card/35 px-2.5 py-2 text-[10px] leading-5 text-muted sm:text-[11px]">
            当前还没有可用的系统排盘术数。
          </div>
        ) : (
          <div className="-mx-1 px-1">
            <div className="flex gap-1.5 overflow-x-auto scrollbar-hide px-1 pb-1 pt-0.5 snap-x snap-mandatory">
              {loading
                ? Array.from({ length: 4 }).map((_, index) => (
                    <LoadingCard key={`paipan-loading-${index}`} />
                  ))
                : catalog.map((item) => (
                    <button
                      key={item.skill}
                      type="button"
                      onClick={() => onSelectSkill(item.skill)}
                      disabled={disabled}
                      className="group min-h-[58px] min-w-[108px] snap-start rounded-xl border border-hairline bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.015))] px-2.5 py-2 text-left transition-all duration-200 hover:border-primary/35 hover:bg-surface-cream-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:ring-inset active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-40 sm:min-w-[120px]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/10 px-1.5 text-[8px] font-medium text-primary">
                          术数
                        </span>
                        <ChevronRight
                          size={12}
                          className="shrink-0 text-muted transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-primary"
                        />
                      </div>

                      <p className="mt-2 line-clamp-1 text-[11px] font-semibold tracking-tight text-ink sm:text-[12px]">
                        {item.name}
                      </p>
                    </button>
                  ))}
            </div>
          </div>
        )}
      </div>

      {loading && (
        <div className="mt-1.5 flex items-center gap-1.5 px-1 text-[10px] text-muted">
          <Loader2 size={12} className="animate-spin" />
          正在加载可用术数...
        </div>
      )}

      {(enabledSkillsLoading || hasEnabledSkills) && (
        <div className="mt-2 border-t border-hairline/60 pt-2">
          <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] font-medium text-muted">
            {enabledSkillsLoading ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Share2 size={11} />
            )}
            <span>已开启 Skill</span>
          </div>
          <div className="flex gap-1.5 overflow-x-auto scrollbar-hide px-1 pb-0.5">
            {enabledSkillsLoading
              ? Array.from({ length: 3 }).map((_, index) => (
                  <span
                    key={`enabled-skill-loading-${index}`}
                    className="h-7 min-w-[86px] shrink-0 rounded-lg border border-hairline bg-surface-card/50"
                  />
                ))
              : enabledSkills.map((skill) => (
                  <span
                    key={`${skill.source}-${skill.id}`}
                    className="inline-flex h-7 max-w-[160px] shrink-0 items-center gap-1 rounded-lg border border-hairline bg-surface-card/65 px-2 text-[10px] font-medium text-ink"
                    title={skill.name}
                  >
                    <Share2 size={10} className="text-primary" />
                    <span className="truncate">{skill.name}</span>
                    {skill.source === 'subscribed' && (
                      <span className="text-[9px] text-muted">订阅</span>
                    )}
                  </span>
                ))}
          </div>
        </div>
      )}
    </section>
  );
}
