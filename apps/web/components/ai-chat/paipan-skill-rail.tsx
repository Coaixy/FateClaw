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
    <div className="h-11 rounded-xl border border-hairline bg-surface-card/60 px-3 py-2">
      <div className="flex h-full items-center gap-1.5">
        <div className="h-6 w-6 rounded-full bg-hairline/60" />
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
    <section className="rounded-2xl border border-primary/15 bg-[linear-gradient(180deg,rgba(204,120,92,0.08),rgba(255,255,255,0.03))] p-3 shadow-sm">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-on-primary shadow-sm">
              <Sparkles size={15} />
            </div>
            <div>
              <p className="text-[14px] font-semibold tracking-tight text-ink">
                选择术数开始排盘
              </p>
              <p className="mt-0.5 text-[10px] text-muted">
                先生成盘面，再决定是否发给 AI 解读
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
            className="h-9 rounded-lg px-2.5"
          >
            自贴盘面
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={onOpenAll}
            disabled={disabled || loading || isEmpty}
            className="h-9 rounded-lg px-3"
          >
            更多术数
          </Button>
        </div>
      </div>

      <div
        className={`mt-3 grid gap-2.5 ${
          shouldShowEnabledSkills ? 'md:grid-cols-[1.35fr_0.85fr]' : ''
        }`}
      >
        <div className="min-w-0 rounded-xl border border-primary/20 bg-surface-card/55 p-2.5 shadow-sm">
          {isEmpty ? (
            <div className="rounded-xl border border-dashed border-primary/25 bg-surface-card/45 px-3 py-3 text-[11px] leading-5 text-muted">
              当前还没有可用的系统排盘术数。
            </div>
          ) : (
            <>
              <div className="mb-2.5 flex items-center justify-between gap-1.5 px-0.5">
                <span className="text-[11px] font-semibold text-primary">
                  可用术数
                </span>
                {!loading && catalog.length > 0 && (
                  <span className="rounded-full border border-primary/20 bg-primary/8 px-2 py-0.5 text-[10px] font-medium text-primary">
                    {catalog.length} 个
                  </span>
                )}
              </div>
              <div className="grid gap-1.5">
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
                        className="group flex min-h-11 min-w-0 items-center gap-2 rounded-xl border border-primary/20 bg-[linear-gradient(180deg,rgba(255,255,255,0.68),rgba(255,255,255,0.32))] px-3 text-left shadow-[0_1px_0_rgba(255,255,255,0.5)_inset] transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/45 hover:bg-primary/8 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:ring-inset active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-[10px] font-semibold text-primary transition-colors duration-200 group-hover:bg-primary group-hover:text-on-primary">
                          术
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight text-ink">
                          {item.name}
                        </span>
                        <span className="hidden shrink-0 rounded-full bg-primary/10 px-2 py-1 text-[10px] font-semibold text-primary transition-colors duration-200 group-hover:bg-primary group-hover:text-on-primary sm:inline-flex">
                          开始
                        </span>
                        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-card text-muted transition-all duration-200 group-hover:translate-x-0.5 group-hover:bg-primary group-hover:text-on-primary">
                          <ChevronRight size={13} />
                        </span>
                      </button>
                    ))}
              </div>
              {loading && (
                <div className="mt-2.5 flex items-center gap-1.5 px-0.5 text-[11px] text-muted">
                  <Loader2 size={12} className="animate-spin" />
                  正在加载可用术数...
                </div>
              )}
            </>
          )}
        </div>

        {shouldShowEnabledSkills && (
          <div className="min-w-0 rounded-xl border border-hairline/60 bg-surface-card/25 p-2.5">
            <div className="mb-2.5 flex items-center justify-between gap-1.5 px-0.5">
              <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-muted">
                {enabledSkillsLoading ? (
                  <Loader2 size={11} className="shrink-0 animate-spin" />
                ) : (
                  <Share2 size={11} className="shrink-0" />
                )}
                <span>已开启 Skill</span>
              </div>
              {!enabledSkillsLoading && hasEnabledSkills && (
                <span className="rounded-full border border-hairline bg-surface-card/55 px-2 py-0.5 text-[10px] text-muted">
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
                        className="h-8 rounded-lg border border-hairline bg-surface-card/50"
                      />
                    ))
                  : enabledSkills.map((skill) => (
                      <span
                        key={`${skill.source}-${skill.id}`}
                        className="inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg border border-hairline/70 bg-surface-card/45 px-2 text-[10px] font-medium text-muted"
                        title={skill.name}
                      >
                        <Share2 size={10} className="shrink-0 text-primary/75" />
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
              <div className="rounded-xl border border-dashed border-hairline bg-surface-card/35 px-3 py-3">
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
