'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Languages } from 'lucide-react';

import { LOCALE_OPTIONS, useI18n } from '@/lib/i18n';

type LanguageSwitcherMenuPlacement = 'top' | 'bottom';

interface LanguageSwitcherProps {
  compact?: boolean;
  collapseOnDesktop?: boolean;
  menuPlacement?: LanguageSwitcherMenuPlacement;
}

/**
 * Render the shared language selector, including the desktop sidebar rail.
 *
 * @param props.compact Use the compact control size.
 * @param props.collapseOnDesktop Show only the icon at desktop widths.
 * @param props.menuPlacement Open upward by default, or downward in page headers.
 * @returns The current language selector.
 */
export function LanguageSwitcher({
  compact = false,
  collapseOnDesktop = false,
  menuPlacement = 'top',
}: LanguageSwitcherProps) {
  const { locale, setLocale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const currentLanguage = t(
    LOCALE_OPTIONS.find((option) => option.value === locale)?.labelKey ??
      'language.zhCN',
  );
  const menuPositionClass =
    menuPlacement === 'bottom' ? 'top-full mt-2' : 'bottom-full mb-2';

  useEffect(() => {
    if (!open) {
      return;
    }

    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex min-w-0 shrink-0 items-center rounded-lg border border-hairline/60 bg-surface-card/70 text-ink shadow-sm transition-all hover:border-primary/30 hover:bg-primary/8 ${
          compact
            ? 'h-9 w-full gap-1.5 px-2 text-[11px]'
            : 'h-10 w-full gap-2 px-3 text-[12px]'
        } ${collapseOnDesktop ? 'lg:h-10 lg:w-10 lg:justify-center lg:border-transparent lg:bg-transparent lg:p-0 lg:shadow-none' : ''}`}
        title={t('language.currentLabel', { language: currentLanguage })}
        aria-label={t('language.switchLabel')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Languages
          size={compact ? 13 : 14}
          className={`shrink-0 text-primary ${collapseOnDesktop ? 'lg:size-[18px]' : ''}`}
          aria-hidden="true"
        />
        <span
          className={`shrink-0 font-medium text-muted ${collapseOnDesktop ? 'lg:hidden' : ''}`}
        >
          {t('language.label')}
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-left font-semibold ${collapseOnDesktop ? 'lg:hidden' : ''}`}
        >
          {currentLanguage}
        </span>
        <ChevronDown
          size={compact ? 12 : 13}
          className={`shrink-0 text-muted transition-transform ${
            open ? 'rotate-180 text-primary' : ''
          } ${collapseOnDesktop ? 'lg:hidden' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute left-0 z-50 w-full min-w-[168px] overflow-hidden rounded-xl border border-hairline bg-surface-card p-1.5 shadow-xl ${menuPositionClass}`}
        >
          {LOCALE_OPTIONS.map((option) => {
            const selected = option.value === locale;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  setLocale(option.value);
                  setOpen(false);
                }}
                className={`flex h-9 w-full items-center justify-between gap-2 rounded-lg px-2.5 text-left text-[12px] font-medium transition-colors ${
                  selected
                    ? 'bg-primary/12 text-primary'
                    : 'text-ink hover:bg-surface-cream-strong'
                }`}
              >
                <span>{t(option.labelKey)}</span>
                {selected && <Check size={13} className="shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
