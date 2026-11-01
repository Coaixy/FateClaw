'use client';

import Link from 'next/link';
import type {
  MemoryEvidenceDto,
  MemoryItemDto,
} from '@fateclaw/contracts/memory';
import { ExternalLink, Loader2 } from 'lucide-react';

import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

export function MemoryEvidencePanel({
  item,
  evidence,
  loading,
  error,
  pending,
  onClose,
  onRetry,
  onExclude,
}: {
  item: MemoryItemDto | null;
  evidence: MemoryEvidenceDto[];
  loading: boolean;
  error: string;
  pending: string;
  onClose: () => void;
  onRetry: () => void;
  onExclude: (sourceId: string) => void;
}) {
  const { t, formatDate } = useI18n();

  return (
    <BottomSheet
      open={Boolean(item)}
      onClose={onClose}
      title={t('memory.evidenceTitle')}
      aria-label={t('memory.evidenceTitle')}
      size="lg"
    >
      <div className="space-y-4 p-4 sm:p-6">
        {item && (
          <p className="whitespace-pre-wrap break-words text-[14px] leading-6">
            {item.content}
          </p>
        )}
        {error && (
          <div
            role="alert"
            className="rounded-xl border border-error/20 p-3 text-[12px] text-error"
          >
            {error}
            <Button variant="ghost" size="sm" onClick={onRetry}>
              {t('memory.retry')}
            </Button>
          </div>
        )}
        {loading ? (
          <div className="flex justify-center gap-2 py-8 text-[12px] text-muted">
            <Loader2 size={16} className="animate-spin" />
            {t('memory.loading')}
          </div>
        ) : (
          <MemoryEvidenceList
            evidence={evidence}
            pending={pending}
            onExclude={onExclude}
          />
        )}
        {!loading && !error && evidence.length === 0 && (
          <p className="py-5 text-center text-[12px] text-muted">
            {t('memory.noEvidence')}
          </p>
        )}
        <p className="text-[11px] leading-5 text-muted">
          {t('memory.excludeDescription')}
        </p>
        {item && (
          <p className="text-[11px] text-muted">
            {t('memory.observedAt', {
              date: formatDate(item.observed_at, { dateStyle: 'medium' }),
            })}
          </p>
        )}
      </div>
    </BottomSheet>
  );
}

export function MemoryEvidenceList({
  evidence,
  pending,
  onExclude,
}: {
  evidence: MemoryEvidenceDto[];
  pending: string;
  onExclude?: (sourceId: string) => void;
}) {
  const { t, formatDate } = useI18n();
  return (
    <ul className="space-y-3">
      {evidence.map((source) => (
        <li
          key={source.id}
          className="rounded-xl border border-hairline bg-canvas/60 p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
            <span>
              {source.scope_name && (
                <span className="mr-2">{source.scope_name}</span>
              )}
              {t(`memory.sourceRoles.${source.source_role}`)} ·{' '}
              {formatDate(source.observed_at, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </span>
            {!source.source_available && (
              <span>{t('memory.sourceUnavailable')}</span>
            )}
          </div>
          <blockquote className="mt-3 whitespace-pre-wrap break-words border-l-2 border-primary/40 pl-3 text-[13px] leading-6 text-ink">
            {source.source_available && source.quote
              ? source.quote
              : t('memory.quoteUnavailable')}
          </blockquote>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            {source.session_id && source.source_available ? (
              <Link
                href={`/ai-chat?sid=${encodeURIComponent(source.session_id)}`}
                className="inline-flex min-h-9 items-center gap-1.5 text-[12px] text-primary"
              >
                <ExternalLink size={12} />
                {t('memory.openConversation')}
              </Link>
            ) : (
              <span />
            )}
            {onExclude && (
              <Button
                variant="ghost"
                size="sm"
                disabled={Boolean(pending)}
                loading={pending === `source:${source.source_id}`}
                onClick={() => onExclude(source.source_id)}
              >
                {t('memory.excludeSource')}
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
