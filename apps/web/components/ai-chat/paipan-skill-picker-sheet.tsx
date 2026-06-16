'use client';

import { ArrowUpRight, Loader2, Sparkles } from 'lucide-react';

import { BottomSheet } from '@/components/ui/bottom-sheet';
import type { PaipanCatalogItem } from '@/features/paipan/api';
import { useI18n } from '@/lib/i18n';

interface PaipanSkillPickerSheetProps {
  open: boolean;
  catalog: PaipanCatalogItem[];
  loading: boolean;
  onClose: () => void;
  onSelectSkill: (skill: string) => void;
}

function LoadingTile() {
  return (
    <div className="rounded-2xl border border-hairline bg-surface-card/55 px-3 py-3 sm:px-4 sm:py-4">
      <div className="flex items-center justify-between gap-2">
        <div className="h-7 w-7 rounded-full bg-hairline/60" />
        <div className="h-3.5 w-3.5 rounded-full bg-hairline/45" />
      </div>
      <div className="mt-4 h-4 w-20 rounded-full bg-hairline/45" />
      <div className="mt-1.5 h-3 w-14 rounded-full bg-hairline/30" />
    </div>
  );
}

export function PaipanSkillPickerSheet({
  open,
  catalog,
  loading,
  onClose,
  onSelectSkill,
}: PaipanSkillPickerSheetProps) {
  const { t } = useI18n();

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      variant="fullscreen-sheet"
      size="lg"
      title={t('aiChat.paipanPicker.title')}
      titleExtra={
        <span className="rounded-full border border-hairline bg-surface-card/70 px-2.5 py-1 text-[10px] text-muted">
          {t('aiChat.paipanPicker.optionalEntry')}
        </span>
      }
    >
      <div className="space-y-3 px-3 py-3 sm:px-6 sm:py-5">
        <div className="rounded-2xl border border-hairline bg-[linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.015))] px-3 py-3 sm:px-4 sm:py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/12 text-primary">
              <Sparkles size={14} />
            </div>
            <div className="min-w-0">
              <p className="text-[12px] sm:text-[14px] font-semibold tracking-tight text-ink">
                {t('aiChat.paipanPicker.selectTitle')}
              </p>
              <p className="mt-0.5 text-[10px] leading-4 text-muted">
                {t('aiChat.paipanPicker.selectDescription')}
              </p>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-1.5 sm:gap-2">
            <div className="rounded-xl border border-hairline bg-surface-card/55 px-2 py-2 sm:px-3 sm:py-2.5">
              <p className="text-[9px] text-muted">
                {t('aiChat.paipanPicker.step')}
              </p>
              <p className="mt-0.5 text-[11px] sm:text-[12px] font-medium text-ink">
                {t('aiChat.paipanPicker.stepSkill')}
              </p>
            </div>
            <div className="rounded-xl border border-hairline bg-surface-card/45 px-2 py-2 opacity-75 sm:px-3 sm:py-2.5">
              <p className="text-[9px] text-muted">
                {t('aiChat.paipanPicker.step')}
              </p>
              <p className="mt-0.5 text-[11px] sm:text-[12px] font-medium text-ink">
                {t('aiChat.paipanPicker.stepInfo')}
              </p>
            </div>
            <div className="rounded-xl border border-hairline bg-surface-card/45 px-2 py-2 opacity-75 sm:px-3 sm:py-2.5">
              <p className="text-[9px] text-muted">
                {t('aiChat.paipanPicker.step')}
              </p>
              <p className="mt-0.5 text-[11px] sm:text-[12px] font-medium text-ink">
                {t('aiChat.paipanPicker.stepPreview')}
              </p>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="space-y-2.5">
            <div className="flex items-center gap-1.5 text-[10px] text-muted">
              <Loader2 size={12} className="animate-spin" />
              {t('aiChat.paipanPicker.loading')}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <LoadingTile key={`paipan-picker-loading-${index}`} />
              ))}
            </div>
          </div>
        ) : catalog.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-hairline bg-surface-card/35 px-3 py-4 text-[10px] sm:text-[11px] leading-5 text-muted">
            {t('aiChat.paipanPicker.empty')}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
            {catalog.map((item) => (
              <button
                key={item.skill}
                type="button"
                onClick={() => onSelectSkill(item.skill)}
                className="group rounded-2xl border border-hairline bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.015))] px-3 py-3 text-left transition-all duration-200 hover:border-primary/35 hover:bg-surface-cream-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset active:scale-[0.99] sm:px-4 sm:py-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-primary/10 px-2 text-[9px] font-medium text-primary">
                    {t('aiChat.paipanPicker.systemBadge')}
                  </span>
                  <ArrowUpRight
                    size={15}
                    className="shrink-0 text-muted transition-all duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary"
                  />
                </div>
                <p className="mt-4 text-[13px] sm:text-[15px] font-semibold tracking-tight text-ink">
                  {item.name}
                </p>
                <p className="mt-0.5 text-[10px] text-muted">
                  {t('aiChat.paipanPicker.enterManual')}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>
    </BottomSheet>
  );
}
