'use client';

import { useEffect, useRef, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import type { ServiceTokenUsageDto } from '@fateclaw/contracts/service-status';
import { useI18n } from '@/lib/i18n';
import styles from './token-growth-panel.module.css';

function useAnimatedCounter(
  target: number | null,
  observedAt?: string,
  initialValue = target ?? 0,
) {
  const [value, setValue] = useState<number | null>(null);
  const current = useRef<number | null>(null);

  useEffect(() => {
    if (target === null) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let started: number | undefined;
    const from = current.current ?? initialValue;
    // Keep an observed increment moving across minute-long snapshot refreshes.
    const duration = 90_000;
    const finish = () => {
      cancelAnimationFrame(frame);
      current.current = target;
      setValue(target);
    };
    const tick = (timestamp: number) => {
      started ??= timestamp;
      const progress = Math.min(1, (timestamp - started) / duration);
      const next = Math.floor(from + (target - from) * progress);
      current.current = next;
      setValue(next);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    const onPreferenceChange = () => {
      if (motion.matches || document.visibilityState === 'hidden') finish();
    };
    if (
      target <= from ||
      motion.matches ||
      document.visibilityState === 'hidden'
    )
      finish();
    else frame = requestAnimationFrame(tick);
    motion.addEventListener('change', onPreferenceChange);
    document.addEventListener('visibilitychange', onPreferenceChange);
    return () => {
      cancelAnimationFrame(frame);
      motion.removeEventListener('change', onPreferenceChange);
      document.removeEventListener('visibilitychange', onPreferenceChange);
    };
  }, [target, observedAt, initialValue]);

  return value;
}

function AnimatedTokenCounter({ usage }: { usage?: ServiceTokenUsageDto }) {
  const { locale, formatNumber } = useI18n();
  const total = usage?.total_tokens ?? null;
  const animated = useAnimatedCounter(
    total,
    usage?.updated_at,
    usage ? usage.total_tokens - usage.today_tokens : 0,
  );
  const parts =
    animated === null
      ? []
      : new Intl.NumberFormat(locale).formatToParts(animated);
  const lastInteger = parts.findLastIndex((part) => part.type === 'integer');
  const scale = Math.min(1, 13 / formatNumber(total ?? 0).length);

  return (
    <div
      className={styles.counter}
      style={{ fontSize: `clamp(1rem, ${8.5 * scale}vw, ${7.5 * scale}rem)` }}
      aria-hidden="true"
    >
      {parts.length ? (
        parts.map((part, index) => (
          <span
            key={index}
            className={
              index === lastInteger
                ? styles.counterAccent
                : part.type === 'group'
                  ? styles.separator
                  : undefined
            }
          >
            {part.value}
          </span>
        ))
      ) : (
        <span className="text-on-dark/25">—</span>
      )}
    </div>
  );
}

export function TokenGrowthPanel({
  usage,
  loading,
  stale,
}: {
  usage?: ServiceTokenUsageDto;
  loading: boolean;
  stale: boolean;
}) {
  const { t, formatNumber } = useI18n();
  const week = usage?.daily
    .slice(-7)
    .reduce((sum, point) => sum + point.tokens, 0);
  const syncState = t(
    `serviceStatus.tokens.${!usage ? (loading ? 'awaiting' : 'noDataShort') : stale ? 'cached' : 'syncing'}`,
  );

  return (
    <section
      className={styles.hero}
      aria-labelledby="token-growth-title"
      aria-busy={loading && !usage}
    >
      <div className={styles.orbit} aria-hidden="true" />
      <div className="relative flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 text-[11px] tracking-[0.14em] text-on-dark-soft">
          <TrendingUp size={15} className="text-primary" />
          {t('serviceStatus.tokens.observatory')}
        </div>
        <span
          className={`size-1.5 rounded-full ${usage && !stale ? styles.syncDot : 'bg-on-dark-soft/50'}`}
          role="status"
          aria-label={syncState}
          title={syncState}
        />
      </div>
      <div
        className="relative py-7 sm:py-9"
        title={usage ? formatNumber(usage.total_tokens) : undefined}
      >
        <h2 id="token-growth-title" className="text-sm text-on-dark/75">
          {t('serviceStatus.tokens.total')}
        </h2>
        <AnimatedTokenCounter usage={usage} />
        <p role="status" className="sr-only">
          {t('serviceStatus.tokens.total')}：
          {usage ? formatNumber(usage.total_tokens) : syncState}
        </p>
      </div>
      <div className="relative grid grid-cols-3 divide-x divide-on-dark/10 border-t border-on-dark/12">
        {[
          { label: 'today', value: usage?.today_tokens, plus: true },
          { label: 'week', value: week, plus: true },
          {
            label: 'dailyAverage',
            value: week === undefined ? undefined : Math.round(week / 7),
            plus: false,
          },
        ].map((metric) => (
          <div
            key={metric.label}
            className="min-w-0 px-3 pb-2 pt-4 first:pl-0 last:pr-0 sm:px-6 sm:pt-5"
          >
            <p className="text-[10px] text-on-dark-soft sm:text-xs">
              {t(`serviceStatus.tokens.${metric.label}`)}
            </p>
            <p
              className={`mt-2 whitespace-nowrap font-mono text-sm tabular-nums sm:mt-3 sm:text-xl ${metric.plus ? 'text-primary' : 'text-on-dark'}`}
            >
              {metric.value === undefined
                ? '—'
                : formatNumber(metric.value, {
                    signDisplay: metric.plus ? 'always' : 'auto',
                    notation: 'compact',
                    maximumFractionDigits: 0,
                  })}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
