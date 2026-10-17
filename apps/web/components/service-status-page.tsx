'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import type {
  ServiceAvailabilityDto,
  ServiceStatusDetailsDto,
  ServiceStatusOverviewDto,
} from '@fateclaw/contracts/service-status';
import { useI18n } from '@/lib/i18n';
import { serviceStatusApi } from '@/features/service-status/api';
import {
  serviceStatusHistory,
  visibleServiceStatus,
  visibleBenefitSupply,
} from '@/features/service-status/history';
import { BrandSeal } from './brand/brand-marks';
import { LanguageSwitcher } from './language-switcher';
import { TokenGrowthPanel } from './service-status/token-growth-panel';

const STATUS_STYLES: Record<ServiceAvailabilityDto, string> = {
  operational: 'bg-success',
  unavailable: 'bg-error',
  unknown: 'bg-hairline',
};

export function ServiceStatusPage() {
  const { t } = useI18n();
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
    }, 60_000);
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
  const benefit = data?.services?.find(
    (service) => service.pool_key === 'benefit',
  );
  const supply =
    benefit && now !== null ? visibleBenefitSupply(benefit, now) : 'unknown';
  const benefitTone =
    supply === 'available'
      ? 'text-success'
      : supply === 'unavailable'
        ? 'text-error'
        : supply === 'exhausted' || supply === 'busy'
          ? 'text-warning'
          : 'text-muted';

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <header className="border-b border-hairline/70">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-5 py-5 sm:px-8">
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
      <main className="mx-auto max-w-6xl px-5 pb-10 pt-8 sm:px-8 sm:pt-10">
        <div className="mb-6 flex items-center justify-between gap-5">
          <h1 className="font-display text-3xl font-semibold sm:text-4xl">
            {t('serviceStatus.title')}
          </h1>
          <button
            type="button"
            disabled={loading}
            onClick={() => setRefreshKey((value) => value + 1)}
            aria-label={t('serviceStatus.refresh')}
            className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg border border-hairline px-3 text-[12px] text-muted hover:border-primary/30 hover:text-ink disabled:opacity-50"
          >
            <RefreshCw
              size={14}
              className={
                loading ? 'animate-spin motion-reduce:animate-none' : ''
              }
            />
            <span className="hidden sm:inline">
              {t('serviceStatus.refresh')}
            </span>
          </button>
        </div>
        {loadFailed && (
          <p role="alert" className="mb-4 text-xs text-muted">
            {t('serviceStatus.readFailed')}
          </p>
        )}
        <section
          className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2"
          aria-label={t('serviceStatus.history')}
        >
          <ServiceCheckHistory
            label={t('modelChoice.paid')}
            state={t(`serviceStatus.${status}Short`)}
            tone={
              status === 'operational'
                ? 'text-success'
                : status === 'unavailable'
                  ? 'text-error'
                  : 'text-muted'
            }
            service={data}
            now={now}
          />
          <ServiceCheckHistory
            label={t('modelChoice.benefit')}
            state={
              supply === 'unavailable'
                ? t('serviceStatus.unavailableShort')
                : t(`modelChoice.${supply}`)
            }
            tone={benefitTone}
            service={benefit}
            now={now}
          />
        </section>
        <TokenGrowthPanel
          usage={data?.token_usage}
          loading={loading}
          stale={
            loadFailed ||
            (now !== null &&
              !!data?.token_usage &&
              now - Date.parse(data.token_usage.updated_at) > 180_000)
          }
        />
      </main>
    </div>
  );
}

function ServiceCheckHistory({
  label,
  state,
  tone,
  service,
  now,
}: {
  label: string;
  state: string;
  tone: string;
  service?: ServiceStatusDetailsDto | null;
  now: number | null;
}) {
  const { t, formatDate } = useI18n();
  const samples =
    now === null
      ? Array<ServiceStatusDetailsDto['history'][number] | null>(28).fill(null)
      : serviceStatusHistory(service?.history ?? [], now);
  return (
    <section
      className="rounded-2xl border border-hairline bg-surface-raised p-4 sm:p-5"
      aria-label={label}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{label}</h2>
        <span
          className={`inline-flex items-center gap-2 text-xs ${tone}`}
          aria-live="polite"
        >
          <span
            className="size-1.5 shrink-0 rounded-full bg-current"
            aria-hidden="true"
          />
          {state}
        </span>
      </div>
      <div
        className="mt-4 grid grid-cols-[repeat(28,minmax(0,1fr))] gap-1"
        aria-label={t('serviceStatus.history')}
      >
        {samples.map((sample, index) => {
          const title = sample
            ? `${formatDate(sample.checked_at, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${t(`serviceStatus.${sample.status}Short`)}`
            : t('serviceStatus.noSample');
          return (
            <div
              key={index}
              role="img"
              aria-label={title}
              title={title}
              className={`h-7 rounded-sm ${sample ? STATUS_STYLES[sample.status] : 'bg-hairline/55'}`}
            />
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-muted">
        <span>{t('serviceStatus.sevenDaysAgo')}</span>
        <span>{t('serviceStatus.now')}</span>
      </div>
    </section>
  );
}
