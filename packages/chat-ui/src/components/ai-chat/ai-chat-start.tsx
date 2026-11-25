'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  ChevronRight,
  Compass,
  MessageCircle,
  Sparkles,
  Users,
} from 'lucide-react';
import { BaguaRing } from '../brand/brand-marks';
import { useI18n } from '../../lib/i18n';

export type NewChatStartMode = 'choice' | 'paipan' | 'plain';

export function AiChatEmptyState({
  title,
  description,
  hint,
  frameClassName = 'justify-center',
  maxWidthClassName = 'max-w-xl',
  children,
}: {
  title: string;
  description: string;
  hint?: string;
  frameClassName?: string;
  maxWidthClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex h-full flex-col items-center px-3 ${frameClassName}`}>
      <div
        className={`w-full ${maxWidthClassName} flex flex-col items-center gap-3.5`}
      >
        <BaguaRing className="mb-2 h-24 w-24 text-primary opacity-[0.22]" />
        {(title || description) && (
          <div className="text-center space-y-1">
            {title && (
              <h1 className="font-display text-[22px] sm:text-[26px] lg:text-[28px] font-semibold tracking-tight text-ink">
                {title}
              </h1>
            )}
            {description && (
              <p className="text-[12px] sm:text-[13px] text-muted">
                {description}
              </p>
            )}
          </div>
        )}
        <div className="w-full">{children}</div>
        {hint && (
          <p className="text-center text-[10px] sm:text-[11px] text-muted/50 select-none">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

export function NewChatStartChoice({
  onChoosePaipan,
  onChoosePlain,
}: {
  onChoosePaipan: () => void;
  onChoosePlain: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="grid w-full gap-2.5">
      <button
        type="button"
        onClick={onChoosePaipan}
        className="btn-tactile group flex min-h-[72px] w-full items-center gap-3 rounded-lg border border-primary/25 bg-primary/6 px-4 py-3 text-left text-ink transition-all hover:border-primary/40 hover:bg-primary/9 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
          <Compass size={19} strokeWidth={1.9} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold">
            {t('aiChat.start.paipan')}
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">
            {t('aiChat.start.paipanDescription')}
          </span>
        </span>
        <ChevronRight
          size={16}
          className="shrink-0 text-primary/60 transition-transform group-hover:translate-x-0.5"
        />
      </button>

      <button
        type="button"
        onClick={onChoosePlain}
        className="btn-tactile group flex min-h-[72px] w-full items-center gap-3 rounded-lg border border-hairline bg-surface-raised px-4 py-3 text-left text-ink transition-all hover:border-primary/35 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <MessageCircle size={18} strokeWidth={1.9} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold">
            {t('aiChat.start.plain')}
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">
            {t('aiChat.start.plainDescription')}
          </span>
        </span>
        <ChevronRight
          size={16}
          className="shrink-0 text-primary/60 transition-transform group-hover:translate-x-0.5"
        />
      </button>

      <div className="mt-1 grid grid-cols-2 gap-2.5">
        <Link
          href="/studio"
          className="btn-tactile group flex min-h-[64px] items-center gap-3 rounded-lg border border-hairline bg-surface-raised px-3.5 py-3 text-left text-ink transition-all hover:border-primary/35 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
          aria-label={t('hub.studio')}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles size={16} strokeWidth={1.9} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold">
              {t('hub.studio')}
            </span>
            <span className="mt-0.5 block truncate text-[11px] leading-snug text-muted">
              {t('hub.studioDescription')}
            </span>
          </span>
        </Link>
        <Link
          href="/clients"
          className="btn-tactile group flex min-h-[64px] items-center gap-3 rounded-lg border border-hairline bg-surface-raised px-3.5 py-3 text-left text-ink transition-all hover:border-primary/35 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
          aria-label={t('hub.clients')}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Users size={16} strokeWidth={1.9} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold">
              {t('hub.clients')}
            </span>
            <span className="mt-0.5 block truncate text-[11px] leading-snug text-muted">
              {t('hub.clientsDescription')}
            </span>
          </span>
        </Link>
      </div>
    </div>
  );
}
