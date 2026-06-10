'use client';

import {
  ChevronRight,
  ClipboardPaste,
  Loader2,
  Share2,
  Sparkles,
  Store,
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
  showEnabledSkillsEmptyState?: boolean;
  disabled?: boolean;
  pastedBoardDisabled?: boolean;
  onSelectSkill: (skill: string) => void;
  onOpenAll: () => void;
  onOpenSkillMarket: () => void;
  onOpenPastedBoard: () => void;
}

function LoadingCard() {
  return (
    <div className="h-8 rounded-lg border border-hairline bg-surface-card/60 px-2 py-1.5">
      <div className="flex h-full items-center gap-1.5">
        <div className="h-4 w-4 rounded-full bg-hairline/60" />
        <div className="h-3 flex-1 rounded-full bg-hairline/45" />
      </div>
    </div>
  );
}

export function PaipanSkillRail({
  catalog,
  loading,
  enabledSkills = [],
  enabledSkillsLoading = false,
  showEnabledSkillsEmptyState = false,
  disabled = false,
  pastedBoardDisabled,
  onSelectSkill,
  onOpenAll,
  onOpenSkillMarket,
  onOpenPastedBoard,
}: PaipanSkillRailProps) {
  const isEmpty = !loading && catalog.length === 0;
  const hasEnabledSkills = enabledSkills.length > 0;
  const shouldShowEnabledSkills =
    enabledSkillsLoading || hasEnabledSkills || showEnabledSkillsEmptyState;

  return (
    <section className="rounded-2xl border border-hairline bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01))] px-2.5 py-2.5 sm:px-3">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
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

        <div className="grid grid-cols-2 gap-1.5 sm:flex sm:shrink-0 sm:flex-wrap sm:items-center sm:justify-end">
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

      <div
        className={`mt-2.5 grid gap-1.5 ${
          shouldShowEnabledSkills ? 'grid-cols-2' : ''
        }`}
      >
        <div className="min-w-0 rounded-xl border border-hairline/60 bg-surface-card/25 p-2">
          {isEmpty ? (
            <div className="rounded-xl border border-dashed border-hairline bg-surface-card/35 px-2.5 py-2 text-[10px] leading-5 text-muted sm:text-[11px]">
              当前还没有可用的系统排盘术数。
            </div>
          ) : (
            <>
              <div className="mb-2 flex items-center justify-between gap-1.5 px-0.5">
                <span className="text-[10px] font-medium text-muted">
                  可用术数
                </span>
                {!loading && catalog.length > 0 && (
                  <span className="rounded-full border border-hairline bg-surface-card/55 px-2 py-0.5 text-[9px] text-muted">
                    {catalog.length} 个
                  </span>
                )}
              </div>
              <div className="grid gap-1">
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
                        className="group flex h-7 min-w-0 items-center gap-1.5 rounded-lg border border-hairline bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.015))] px-2 text-left transition-all duration-200 hover:border-primary/35 hover:bg-surface-cream-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:ring-inset active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[8px] font-medium text-primary">
                          术
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-tight text-ink sm:text-[12px]">
                          {item.name}
                        </span>
                        <ChevronRight
                          size={11}
                          className="shrink-0 text-muted transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-primary"
                        />
                      </button>
                    ))}
              </div>
              {loading && (
                <div className="mt-2 flex items-center gap-1.5 px-0.5 text-[10px] text-muted">
                  <Loader2 size={12} className="animate-spin" />
                  正在加载可用术数...
                </div>
              )}
            </>
          )}
        </div>

        {shouldShowEnabledSkills && (
          <div className="min-w-0 rounded-xl border border-hairline/60 bg-surface-card/20 p-2">
            <div className="mb-2 flex items-center justify-between gap-1.5 px-0.5">
              <div className="flex min-w-0 items-center gap-1.5 text-[10px] font-medium text-muted">
                {enabledSkillsLoading ? (
                  <Loader2 size={11} className="shrink-0 animate-spin" />
                ) : (
                  <Share2 size={11} className="shrink-0" />
                )}
                <span>已开启 Skill</span>
              </div>
              {!enabledSkillsLoading && hasEnabledSkills && (
                <span className="rounded-full border border-hairline bg-surface-card/55 px-2 py-0.5 text-[9px] text-muted">
                  {enabledSkills.length} 个
                </span>
              )}
            </div>
            {enabledSkillsLoading || hasEnabledSkills ? (
              <div className="grid gap-1">
                {enabledSkillsLoading
                  ? Array.from({ length: 3 }).map((_, index) => (
                      <span
                        key={`enabled-skill-loading-${index}`}
                        className="h-7 rounded-lg border border-hairline bg-surface-card/50"
                      />
                    ))
                  : enabledSkills.map((skill) => (
                      <span
                        key={`${skill.source}-${skill.id}`}
                        className="inline-flex h-7 min-w-0 items-center gap-1 rounded-lg border border-hairline bg-surface-card/65 px-2 text-[10px] font-medium text-ink"
                        title={skill.name}
                      >
                        <Share2 size={10} className="shrink-0 text-primary" />
                        <span className="min-w-0 flex-1 truncate">
                          {skill.name}
                        </span>
                        {skill.source === 'subscribed' && (
                          <span className="shrink-0 text-[9px] text-muted">
                            订阅
                          </span>
                        )}
                      </span>
                    ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-hairline bg-surface-card/35 px-2.5 py-2.5">
                <div className="flex flex-col gap-2">
                  <p className="min-w-0 text-[10px] leading-5 text-muted sm:text-[11px]">
                    Skill 是给 AI Chat 补充专门术数流程、规则和解读偏好的能力包。去技能市场订阅后，可在对话里启用。
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={onOpenSkillMarket}
                    icon={<Store size={12} />}
                    className="h-8 w-full rounded-lg px-2.5"
                  >
                    去技能市场
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
