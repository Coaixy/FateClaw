'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Cpu, Loader2, RefreshCw } from 'lucide-react';

import {
  modelSettingsApi,
  type ModelSettingsOverview,
} from '@/features/model-settings/api';
import { useI18n } from '@/lib/i18n';
import { OfficialModelPriceTags } from './official-model-price-tags';
import { ModelSelector } from '@/components/ai-chat/model-selector';

type ModelState = {
  overview: ModelSettingsOverview | null;
  loading: boolean;
  error: string;
};

export function ModelSettingsPanel() {
  const { t } = useI18n();
  const [{ overview, loading, error }, setState] = useState<ModelState>({
    overview: null,
    loading: true,
    error: '',
  });
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const data = await modelSettingsApi.overview();
      if (requestIdRef.current !== requestId) return;
      setState({ overview: data, loading: false, error: '' });
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

  const model = overview?.model;

  return (
    <section className="rounded-xl border border-hairline bg-surface-raised p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Cpu size={19} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-medium text-muted">
              {t('pages.modelSettings.officialTitle')}
            </p>
            <h3 className="mt-1 text-[16px] font-semibold text-ink">
              {loading
                ? t('pages.modelSettings.loading')
                : model?.display_name || t('pages.modelSettings.unconfigured')}
            </h3>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-hairline px-2.5 text-[12px] font-medium text-muted transition-colors hover:border-primary/35 hover:text-ink disabled:opacity-50"
        >
          {loading ? (
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw size={13} aria-hidden="true" />
          )}
          {t('pages.modelSettings.refresh')}
        </button>
      </div>

      {error ? (
        <p role="alert" className="mt-4 text-[13px] leading-6 text-error">
          {error}
        </p>
      ) : !loading && model ? (
        <div className="mt-4 space-y-3">
          <p className="text-[13px] leading-6 text-muted">
            {model.description || t('pages.modelSettings.officialDescription')}
          </p>
          {!model.has_secret && (
            <p className="text-[12px] text-muted">
              {t('pages.modelSettings.unavailable')}
            </p>
          )}
          <OfficialModelPriceTags model={model} compact />
        </div>
      ) : !loading ? (
        <p className="mt-4 text-[13px] leading-6 text-muted">
          {t(
            overview?.benefit?.model
              ? 'modelChoice.paidUnavailable'
              : 'pages.modelSettings.noOfficialModel',
          )}
        </p>
      ) : null}
      {overview?.benefit ? (
        <div className="mt-4 border-t border-hairline pt-4">
          <p className="mb-2 text-[12px] leading-6 text-muted">
            {t('modelChoice.benefitDescription')}
          </p>
          <ModelSelector
            overview={overview}
            poolKey={overview.preferred_pool ?? 'official'}
            busy={loading}
            error={error}
            onRetry={() => void load()}
            onChange={(key) => {
              const id = ++requestIdRef.current;
              setState((current) => ({ ...current, loading: true, error: '' }));
              void modelSettingsApi
                .setPreference(key)
                .then((data) => {
                  if (id === requestIdRef.current)
                    setState({ overview: data, loading: false, error: '' });
                })
                .catch(() => {
                  if (id === requestIdRef.current)
                    setState((current) => ({
                      ...current,
                      loading: false,
                      error: t('modelChoice.saveFailed'),
                    }));
                });
            }}
          />
        </div>
      ) : null}
    </section>
  );
}
