'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Check,
  Clock3,
  RefreshCw,
} from 'lucide-react';
import type {
  ServiceAvailabilityDto,
  ServiceStatusOverviewDto,
} from '@fateclaw/contracts/service-status';
import { useI18n } from '@/lib/i18n';
import { serviceStatusApi } from '@/features/service-status/api';
import {
  serviceStatusHistory,
  visibleServiceStatus,
} from '@/features/service-status/history';
import { BrandSeal } from './brand/brand-marks';
import { LanguageSwitcher } from './language-switcher';

const STATUS_STYLES: Record<
  ServiceAvailabilityDto,
  { dot: string; background: string; text: string }
> = {
  operational: {
    dot: 'bg-success',
    background: 'bg-success/8 border-success/20',
    text: 'text-success',
  },
  unavailable: {
    dot: 'bg-error',
    background: 'bg-error/8 border-error/20',
    text: 'text-error',
  },
  unknown: {
    dot: 'bg-muted/40',
    background: 'bg-surface-soft border-hairline',
    text: 'text-muted',
  },
};

export function ServiceStatusPage() {
  const { t, formatDate } = useI18n();
  const [data, setData] = useState<ServiceStatusOverviewDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let stopped = false;
    let active: AbortController | undefined;
    const load = async () => {
      if (active || document.visibilityState === 'hidden') return;
      const controller = new AbortController();
      active = controller;
      setLoading(true);
      try {
        const overview = await serviceStatusApi.overview(controller.signal);
        if (!stopped) {
          setData(overview);
          setLoadFailed(false);
          setNow(Date.now());
        }
      } catch {
        if (!stopped) {
          setLoadFailed(true);
          setNow(Date.now());
        }
      } finally {
        active = undefined;
        if (!stopped) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => {
      setNow(Date.now());
      void load();
    }, 5 * 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        setNow(Date.now());
        void load();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      active?.abort();
    };
  }, [refreshKey]);

  const status =
    data && now !== null ? visibleServiceStatus(data, now) : 'unknown';
  const style = STATUS_STYLES[status];
  const history =
    now !== null
      ? serviceStatusHistory(data?.history ?? [], now)
      : Array<ServiceStatusOverviewDto['history'][number] | null>(28).fill(
          null,
        );
  const known = (data?.history ?? []).filter(
    (sample) =>
      sample.status !== 'unknown' &&
      now !== null &&
      Date.parse(sample.checked_at) >= now - 7 * 86400_000,
  );
  const rate = known.length
    ? Math.round(
        (known.filter((sample) => sample?.status === 'operational').length /
          known.length) *
          1000,
      ) / 10
    : null;
  const time = (value: string) =>
    formatDate(value, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <header className="border-b border-hairline/70">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-5 py-5 sm:px-8">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-3"
            aria-label={t('serviceStatus.home')}
          >
            <BrandSeal className="size-9" />
            <span className="text-[15px] font-semibold">
              {t('common.brandName')}
              <span className="ml-2 hidden text-[11px] font-normal tracking-widest text-muted sm:inline">
                FATECLAW
              </span>
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <LanguageSwitcher compact menuPlacement="bottom" />
            <Link
              href="/"
              className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink"
            >
              {t('serviceStatus.home')}
              <ArrowUpRight size={13} />
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-5 pb-16 pt-12 sm:px-8 sm:pt-16">
        <div className="mb-8 flex items-start justify-between gap-5">
          <div>
            <p className="mb-3 text-[10px] uppercase tracking-[0.2em] text-muted">
              FateClaw Status
            </p>
            <h1 className="font-display text-3xl font-semibold sm:text-4xl">
              {t('serviceStatus.title')}
            </h1>
            <p className="mt-3 text-[13px] leading-6 text-muted">
              {t('serviceStatus.subtitle')}
            </p>
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => setRefreshKey((value) => value + 1)}
            aria-label={t('serviceStatus.refresh')}
            className="mt-5 inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg border border-hairline px-3 text-[12px] text-muted hover:border-primary/30 hover:text-ink disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            <span className="hidden sm:inline">
              {t('serviceStatus.refresh')}
            </span>
          </button>
        </div>
        <section
          className={`rounded-2xl border px-6 py-7 sm:px-8 sm:py-9 ${style.background}`}
          aria-live="polite"
        >
          <div className="flex items-center gap-3">
            <span
              className={`size-3 shrink-0 rounded-full ${style.dot}`}
              aria-hidden="true"
            />
            <h2 className={`text-xl font-semibold sm:text-2xl ${style.text}`}>
              {loading && !data
                ? t('serviceStatus.loading')
                : t(`serviceStatus.${status}`)}
            </h2>
          </div>
          <p className="mt-3 pl-6 text-[13px] leading-6 text-body">
            {t(`serviceStatus.${status}Description`)}
          </p>
        </section>
        {loadFailed && (
          <p role="alert" className="mt-4 text-[12px] leading-6 text-muted">
            {t('serviceStatus.readFailed')}
          </p>
        )}
        <section className="mt-7 overflow-hidden rounded-2xl border border-hairline bg-surface-raised">
          <div className="flex items-center justify-between gap-4 border-b border-hairline px-5 py-5 sm:px-7">
            <h2 className="flex items-center gap-2.5 text-[15px] font-semibold">
              <Activity size={17} className="text-muted" />
              {t('serviceStatus.ai')}
            </h2>
            <span className={`text-[12px] ${style.text}`}>
              {t(`serviceStatus.${status}Short`)}
            </span>
          </div>
          <div className="grid grid-cols-1 divide-y divide-hairline sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <div className="px-5 py-6 sm:px-7">
              <p className="text-[11px] text-muted">
                {t('serviceStatus.latency')}
              </p>
              <p className="mt-3 font-mono text-2xl tracking-tight">
                {status === 'operational' &&
                data?.latency_ms !== null &&
                data?.latency_ms !== undefined ? (
                  <>
                    {data.latency_ms.toLocaleString()}
                    <span className="ml-1.5 text-xs text-muted">ms</span>
                  </>
                ) : (
                  '—'
                )}
              </p>
            </div>
            <div className="px-5 py-6 sm:px-7">
              <p className="text-[11px] text-muted">
                {t('serviceStatus.checked')}
              </p>
              <p className="mt-3 text-[16px] font-medium">
                {data?.checked_at
                  ? time(data.checked_at)
                  : t('serviceStatus.waiting')}
              </p>
            </div>
            <div className="px-5 py-6 sm:px-7">
              <p className="text-[11px] text-muted">
                {t('serviceStatus.frequency')}
              </p>
              <p className="mt-3 text-[16px] font-medium">
                {t('serviceStatus.sixHours')}
              </p>
            </div>
          </div>
        </section>
        <section className="mt-9" aria-label={t('serviceStatus.history')}>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-[14px] font-semibold">
              {t('serviceStatus.history')}
            </h2>
            <span className="text-[12px] text-muted">
              {t('serviceStatus.sampleRate')}{' '}
              <span className="font-mono text-ink">
                {rate === null ? '—' : `${rate}%`}
              </span>
            </span>
          </div>
          <div className="grid grid-cols-[repeat(28,minmax(0,1fr))] gap-1 sm:gap-1.5">
            {history.map((sample, index) => {
              const title = sample
                ? `${time(sample.checked_at)} · ${t(`serviceStatus.${sample.status}Short`)}`
                : t('serviceStatus.noSample');
              return (
                <div
                  key={index}
                  role="img"
                  aria-label={title}
                  title={title}
                  className={`h-10 rounded-sm ${sample ? STATUS_STYLES[sample.status].dot : 'bg-hairline/55'}`}
                />
              );
            })}
          </div>
          <div className="mt-3 flex items-center justify-between gap-2 text-[10px] text-muted">
            <span>{t('serviceStatus.sevenDaysAgo')}</span>
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-success" />
                {t('serviceStatus.operationalShort')}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-error" />
                {t('serviceStatus.unavailableShort')}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-hairline" />
                {t('serviceStatus.unknownShort')}
              </span>
            </div>
            <span>{t('serviceStatus.now')}</span>
          </div>
        </section>
        <section className="mt-9 space-y-2 border-t border-hairline pt-5 text-[12px] leading-6 text-muted">
          <p className="flex items-start gap-2">
            <Check size={14} className="mt-1 shrink-0" />
            {t('serviceStatus.aggregateNote')}
          </p>
          <p className="flex items-start gap-2">
            <Clock3 size={14} className="mt-1 shrink-0" />
            {t('serviceStatus.cadenceNote')}
          </p>
          <p className="pl-[22px] text-[11px] text-muted/80">
            {t('serviceStatus.latencyNote')}
          </p>
        </section>
        <footer className="mt-12 flex items-center justify-between border-t border-hairline/60 pt-5 text-[11px] text-muted">
          <span>FateClaw · {t('serviceStatus.title')}</span>
          <Link
            href="/"
            className="inline-flex items-center gap-1 hover:text-ink"
          >
            <ArrowLeft size={12} />
            {t('serviceStatus.home')}
          </Link>
        </footer>
      </main>
    </div>
  );
}
