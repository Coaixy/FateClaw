'use client';

import { ClipboardPaste, Loader2, Sparkles, Store } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { PaipanCatalogItem } from '@/features/paipan/api';
import { useI18n } from '@/lib/i18n';

/**
 * 已启用 Skill 摘要。
 *
 * 注意：排盘工具条本身已不再渲染「已开启 Skill」列表，但 onboarding 引导
 * （use-onboarding-guide-status）仍依赖此类型计算引导进度，故保留导出。
 */
export interface EnabledSkillSummary {
  id: string;
  name: string;
  source: 'own' | 'subscribed';
}

/**
 * 排盘术数工具条 Props。
 *
 * @param catalog 系统可用术数目录
 * @param loading 目录加载中
 * @param disabled 整体禁用（如未登录 / 正在发送）
 * @param pastedBoardDisabled 自贴盘面入口单独禁用
 * @param onSelectSkill 选中某个术数，进入排盘
 * @param onOpenSkillMarket 跳转技能市场（/discover）
 * @param onOpenPastedBoard 打开自贴盘面录入
 */
interface PaipanSkillRailProps {
  catalog: PaipanCatalogItem[];
  loading: boolean;
  disabled?: boolean;
  pastedBoardDisabled?: boolean;
  onSelectSkill: (skill: string) => void;
  onOpenSkillMarket: () => void;
  onOpenPastedBoard: () => void;
}

/** 方块网格加载态骨架：与术数方块同尺寸，避免加载时布局抖动。 */
function LoadingTile() {
  return (
    <div className="flex min-h-[88px] flex-col items-center justify-center gap-2 rounded-xl border border-hairline bg-surface-card/60 p-2">
      <div className="h-9 w-9 rounded-lg bg-hairline/60" />
      <div className="h-3 w-12 rounded-full bg-hairline/45" />
    </div>
  );
}

/**
 * 排盘术数工具条。
 *
 * 顶部为标题与操作区（自贴盘面 / 更多术数 / 技能市场），主体为「可用术数」
 * 方块网格——点击方块即进入对应术数排盘。
 */
export function PaipanSkillRail({
  catalog,
  loading,
  disabled = false,
  pastedBoardDisabled,
  onSelectSkill,
  onOpenSkillMarket,
  onOpenPastedBoard,
}: PaipanSkillRailProps) {
  const { formatNumber, t } = useI18n();
  const isEmpty = !loading && catalog.length === 0;

  return (
    <section className="rounded-2xl border border-hairline bg-surface-raised p-3 shadow-raised">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-on-primary shadow-sm">
              <Sparkles size={15} />
            </div>
            <div>
              <p className="text-[14px] font-semibold tracking-tight text-ink">
                {t('aiChat.paipanRail.title')}
              </p>
              <p className="mt-0.5 text-[10px] text-muted">
                {t('aiChat.paipanRail.description')}
              </p>
            </div>
          </div>
        </div>

        {/* 操作区：辅助入口用 ghost 轻量样式，避免实心按钮与方块网格抢视觉焦点 */}
        <div className="flex flex-wrap items-center gap-1 sm:shrink-0 sm:justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={onOpenPastedBoard}
            disabled={pastedBoardDisabled ?? disabled}
            icon={<ClipboardPaste size={13} />}
            className="h-9 rounded-lg px-2.5"
          >
            {t('aiChat.paipanRail.pasteBoard')}
          </Button>
          {/* 技能市场常驻入口：原嵌于「已开启 Skill」空态，删列后迁至此处保留 */}
          <Button
            size="sm"
            variant="ghost"
            onClick={onOpenSkillMarket}
            icon={<Store size={13} />}
            className="h-9 rounded-lg px-2.5"
          >
            {t('aiChat.paipanRail.skillMarket')}
          </Button>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-hairline/70 bg-surface-soft/50 p-2.5">
        {isEmpty ? (
          <div className="rounded-xl border border-dashed border-primary/25 bg-surface-card/45 px-3 py-3 text-[11px] leading-5 text-muted">
            {t('aiChat.paipanRail.noSystems')}
          </div>
        ) : (
          <>
            <div className="mb-2.5 flex items-center justify-between gap-1.5 px-0.5">
              <span className="text-[11px] font-semibold text-primary">
                {t('aiChat.paipanRail.availableSkills')}
              </span>
              {!loading && catalog.length > 0 && (
                <span className="rounded-full border border-primary/20 bg-primary/8 px-2 py-0.5 text-[10px] font-medium text-primary">
                  {t('common.count', { count: formatNumber(catalog.length) })}
                </span>
              )}
            </div>
            {/* 术数方块网格：窄屏 2 列、平板 3 列、桌面 4 列，比长条列表更紧凑 */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {loading
                ? Array.from({ length: 8 }).map((_, index) => (
                    <LoadingTile key={`paipan-loading-${index}`} />
                  ))
                : catalog.map((item) => (
                    <button
                      key={item.skill}
                      type="button"
                      onClick={() => onSelectSkill(item.skill)}
                      disabled={disabled}
                      title={item.description || item.name}
                      className="btn-tactile group flex min-h-[88px] flex-col items-center justify-center gap-2 rounded-xl border border-hairline bg-surface-raised p-2 text-center transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:ring-inset active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-[11px] font-semibold text-primary transition-colors duration-200 group-hover:bg-primary group-hover:text-on-primary">
                        {t('aiChat.paipanRail.skillGlyph')}
                      </span>
                      <span className="line-clamp-2 w-full text-[12px] font-semibold leading-tight tracking-tight text-ink">
                        {item.name}
                      </span>
                    </button>
                  ))}
            </div>
            {loading && (
              <div className="mt-2.5 flex items-center gap-1.5 px-0.5 text-[11px] text-muted">
                <Loader2 size={12} className="animate-spin" />
                {t('aiChat.paipanRail.loading')}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
