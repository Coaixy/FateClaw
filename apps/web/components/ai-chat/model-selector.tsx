'use client';

import { useRef } from 'react';
import Link from 'next/link';
import { ChevronDown, Check, Loader2, RefreshCw } from 'lucide-react';
import type {
  ModelPoolKey,
  ModelSettingsOverviewDto,
} from '@fateclaw/contracts/model-settings';
import { useI18n } from '@/lib/i18n';

export function ModelSelector({
  overview,
  poolKey,
  busy,
  error,
  onChange,
  onRetry,
}: {
  overview: ModelSettingsOverviewDto | null;
  poolKey: ModelPoolKey;
  busy: boolean;
  error: string;
  onChange: (poolKey: ModelPoolKey) => void;
  onRetry: () => void;
}) {
  const { t, formatDate } = useI18n();
  const details = useRef<HTMLDetailsElement>(null);
  const benefit = overview?.benefit;
  const membershipRequired = Boolean(benefit?.enabled && !benefit.eligible);
  const available =
    !membershipRequired &&
    benefit?.supply === 'available' &&
    Boolean(benefit.model);
  const label =
    poolKey === 'benefit' ? t('modelChoice.benefit') : t('modelChoice.paid');
  const state = membershipRequired
    ? 'membershipRequired'
    : benefit?.supply === 'available' && benefit?.remaining_turns === 0
      ? 'personal'
      : (benefit?.supply ?? 'unknown');
  const choose = (key: ModelPoolKey) => {
    if (details.current) details.current.open = false;
    details.current?.querySelector('summary')?.focus();
    onChange(key);
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
      <details
        ref={details}
        className="group relative"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && details.current)
            details.current.open = false;
        }}
      >
        <summary
          className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-full px-3 text-ink hover:bg-surface-soft [&::-webkit-details-marker]:hidden"
          aria-label={t('modelChoice.switch', { model: label })}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : null}
          {label}
          <ChevronDown size={12} />
        </summary>
        <div
          className="absolute bottom-full left-0 z-30 mb-2 w-72 max-w-[calc(100vw-7rem)] space-y-1 rounded-xl border border-hairline bg-surface-raised p-1.5 shadow-raised"
          role="group"
          aria-label={t('modelChoice.title')}
        >
          {(['official', 'benefit'] as const).map((key) => {
            const free = key === 'benefit';
            return (
              <button
                key={key}
                type="button"
                disabled={
                  busy || (free ? !benefit?.eligible : !overview?.model)
                }
                aria-pressed={poolKey === key}
                aria-label={
                  t(free ? 'modelChoice.benefit' : 'modelChoice.paid') +
                  ' · ' +
                  t(
                    free
                      ? 'modelChoice.benefitDescription'
                      : 'modelChoice.paidDescription',
                  )
                }
                onClick={() => choose(key)}
                className="w-full rounded-lg px-3 py-2.5 text-left hover:bg-surface-soft disabled:opacity-50 aria-pressed:bg-surface-soft"
              >
                <span className="flex items-center justify-between gap-2 text-[13px] text-ink">
                  <span>
                    {t(free ? 'modelChoice.benefit' : 'modelChoice.paid')}
                  </span>
                  {poolKey === key ? <Check size={13} /> : null}
                </span>
                <span className="mt-1 block text-[12px] leading-5 text-muted">
                  {t(
                    free
                      ? 'modelChoice.benefitDescription'
                      : 'modelChoice.paidDescription',
                  )}
                </span>
                <span className="mt-1 block text-[11px] text-primary">
                  {free
                    ? t(
                        available
                          ? 'modelChoice.remaining'
                          : `modelChoice.${state}`,
                        { count: benefit?.remaining_turns ?? 0 },
                      )
                    : t('modelChoice.metered')}
                </span>
              </button>
            );
          })}
          {membershipRequired ? (
            <Link
              href="/membership"
              className="block rounded-lg px-3 py-2 text-[12px] text-primary hover:underline"
            >
              {t('modelChoice.unlock')}
            </Link>
          ) : null}
          <p className="px-3 py-2 text-[11px] leading-5 text-muted">
            {t('modelChoice.noAutoCharge')}
          </p>
        </div>
      </details>
      <div className="min-w-0 flex-1" aria-live="polite">
        {error ? (
          <span
            role="alert"
            className="inline-flex items-center gap-2 text-warning"
          >
            {error}
            <button
              type="button"
              onClick={onRetry}
              aria-label={t('modelChoice.retry')}
            >
              <RefreshCw size={12} />
            </button>
          </span>
        ) : busy ? (
          t('modelChoice.loading')
        ) : poolKey === 'benefit' ? (
          <span>
            {t(
              available && (benefit.remaining_turns ?? 0) > 0
                ? 'modelChoice.shortBenefit'
                : `modelChoice.${state}`,
              { count: benefit?.remaining_turns ?? 0 },
            )}
            {membershipRequired ? (
              <Link
                href="/membership"
                className="ml-2 text-primary hover:underline"
              >
                {t('modelChoice.unlock')}
              </Link>
            ) : null}
          </span>
        ) : !overview?.model ? (
          t('modelChoice.unknown')
        ) : null}
      </div>
      {poolKey === 'benefit' && state === 'personal' && benefit ? (
        <span className="w-full px-2 text-[11px]">
          {t('modelChoice.resets', {
            time: formatDate(benefit.resets_at, {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'Asia/Shanghai',
            }),
          })}
        </span>
      ) : null}
    </div>
  );
}
