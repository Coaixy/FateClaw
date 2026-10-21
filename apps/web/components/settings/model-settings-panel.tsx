'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, Loader2, RefreshCw } from 'lucide-react';
import type { ModelPoolKey } from '@fateclaw/contracts/model-settings';

import {
  modelSettingsApi,
  type ModelSettingsOverview,
} from '@/features/model-settings/api';
import { useI18n } from '@/lib/i18n';
import { OfficialModelPriceTags } from './official-model-price-tags';

type ModelState = {
  overview: ModelSettingsOverview | null;
  loading: boolean;
  error: string;
};

export function ModelSettingsPanel() {
  const { t } = useI18n();
  const [state, setState] = useState<ModelState>({
    overview: null,
    loading: true,
    error: '',
  });
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const overview = await modelSettingsApi.overview();
      if (requestIdRef.current !== requestId) return;
      setState({ overview, loading: false, error: '' });
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setState({
        overview: null,
        loading: false,
        error:
          error instanceof Error
            ? error.message
            : t('pages.modelSettings.loadFailed'),
      });
    }
  }, [t]);

  useEffect(() => {
    void load();
    return () => {
      requestIdRef.current += 1;
    };
  }, [load]);

  const change = async (key: ModelPoolKey) => {
    if (state.loading || key === (state.overview?.preferred_pool ?? 'official'))
      return;
    const requestId = ++requestIdRef.current;
    setState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const overview = await modelSettingsApi.setPreference(key);
      if (requestIdRef.current !== requestId) return;
      setState({ overview, loading: false, error: '' });
    } catch {
      if (requestIdRef.current !== requestId) return;
      setState((current) => ({
        ...current,
        loading: false,
        error: t('modelChoice.saveFailed'),
      }));
    }
  };

  return (
    <ModelSettingsContent
      {...state}
      onRefresh={() => void load()}
      onChange={(key) => void change(key)}
    />
  );
}

export function ModelSettingsContent({
  overview,
  loading,
  error,
  onRefresh,
  onChange,
}: ModelState & {
  onRefresh: () => void;
  onChange: (key: ModelPoolKey) => void;
}) {
  const { t, formatDate } = useI18n();
  const benefit = overview?.benefit;
  const poolKey = overview?.preferred_pool ?? 'official';
  const membershipRequired = Boolean(benefit?.enabled && !benefit.eligible);
  const benefitState = membershipRequired
    ? 'membershipRequired'
    : benefit?.supply === 'available' && benefit.remaining_turns === 0
      ? 'personal'
      : (benefit?.supply ?? 'unknown');
  const available =
    !membershipRequired && benefit?.supply === 'available' && benefit.model;

  return (
    <section
      aria-label={t('modelChoice.title')}
      aria-busy={loading}
      className="space-y-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-ink">
          {t('modelChoice.title')}
        </h3>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs text-muted hover:text-ink disabled:opacity-50"
        >
          {loading ? (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw size={14} aria-hidden="true" />
          )}
          {t('pages.modelSettings.refresh')}
        </button>
      </div>
      <div
        role="group"
        aria-label={t('modelChoice.title')}
        className="grid grid-cols-1 gap-3"
      >
        {(['official', 'benefit'] as const).map((key) => {
          const free = key === 'benefit';
          const model = free ? benefit?.model : overview?.model;
          const selected = poolKey === key;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={selected}
              disabled={loading || !model || (free && !benefit?.eligible)}
              onClick={() => onChange(key)}
              className={`flex min-w-0 flex-col rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-default sm:p-4 ${selected ? 'border-primary bg-primary/5' : 'border-hairline bg-surface-raised'} ${loading || !model || (free && !benefit?.eligible) ? 'opacity-60' : ''}`}
            >
              <span className="flex w-full items-start justify-between gap-1.5">
                <span className="text-sm font-medium text-ink">
                  {t(free ? 'modelChoice.benefit' : 'modelChoice.paid')}
                </span>
                <span
                  aria-hidden="true"
                  className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-primary bg-primary text-on-primary' : 'border-hairline'}`}
                >
                  {selected ? <Check size={11} /> : null}
                </span>
              </span>
              <span className="mt-2 block break-all text-[13px] font-medium leading-5 text-ink sm:text-sm">
                {loading && !overview
                  ? t('pages.modelSettings.loading')
                  : model?.display_name ||
                    t('pages.modelSettings.unconfigured')}
              </span>
              <span className="mb-3 mt-1 block text-xs leading-5 text-muted">
                {t(
                  free
                    ? 'modelChoice.benefitSummary'
                    : 'modelChoice.paidDescription',
                )}
              </span>
              {free ? (
                <span className="mt-auto block text-xs leading-5 text-primary">
                  {t(
                    available && (benefit.remaining_turns ?? 0) > 0
                      ? 'modelChoice.remaining'
                      : `modelChoice.${benefitState}`,
                    { count: benefit?.remaining_turns ?? 0 },
                  )}
                </span>
              ) : model ? (
                <OfficialModelPriceTags model={model} />
              ) : (
                <span className="mt-auto text-xs leading-5 text-muted">
                  {t('pages.modelSettings.unavailable')}
                </span>
              )}
              {model && !model.has_secret ? (
                <span className="mt-1 text-xs text-muted">
                  {t('pages.modelSettings.unavailable')}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {error ? (
        <p
          role="alert"
          className="flex items-center justify-between gap-3 text-xs leading-5 text-error"
        >
          {error}
          <button
            type="button"
            onClick={onRefresh}
            aria-label={t('modelChoice.retry')}
            className="flex size-10 shrink-0 items-center justify-center rounded-lg"
          >
            <RefreshCw size={14} />
          </button>
        </p>
      ) : null}
      {membershipRequired ? (
        <Link
          href="/membership"
          className="inline-flex min-h-10 items-center text-xs text-primary hover:underline"
        >
          {t('modelChoice.unlock')}
        </Link>
      ) : null}
      {benefitState === 'personal' && benefit ? (
        <p className="text-xs leading-5 text-muted">
          {t('modelChoice.resets', {
            time: formatDate(benefit.resets_at, {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'Asia/Shanghai',
            }),
          })}
        </p>
      ) : null}
      <p className="text-[11px] leading-5 text-muted">
        {t('modelChoice.noAutoCharge')}
      </p>
    </section>
  );
}
