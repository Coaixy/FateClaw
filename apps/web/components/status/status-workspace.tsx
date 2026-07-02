'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  CheckCircle2,
  Clock3,
  CreditCard,
  Loader2,
  MessageCircle,
  RefreshCw,
  Server,
  ShieldCheck,
  Smartphone,
  Sparkles,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { billingApi, type PublicStatusOverview } from '@/features/billing/api';
import { useI18n } from '@/lib/i18n';

type DateFormatter = ReturnType<typeof useI18n>['formatDate'];
type PublicStatusService = PublicStatusOverview['services'][number];
type PublicStatusLevel = PublicStatusOverview['overall_status'];

const SERVICE_ICONS = {
  ai_chat: MessageCircle,
  wallet: CreditCard,
  membership: Sparkles,
  wechat_binding: Smartphone,
} as const;

function formatStatusTime(
  value: string | null,
  fallback: string,
  formatDate: DateFormatter,
): string {
  if (!value) return fallback;
  return formatDate(value, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function statusLabelKey(status: PublicStatusLevel) {
  switch (status) {
    case 'maintenance':
      return 'pages.status.stateMaintenance';
    case 'degraded':
      return 'pages.status.stateDegraded';
    case 'operational':
    default:
      return 'pages.status.stateOnline';
  }
}

function statusToneClass(status: PublicStatusLevel) {
  switch (status) {
    case 'maintenance':
      return 'border-warning/30 bg-warning/10 text-warning';
    case 'degraded':
      return 'border-error/30 bg-error/10 text-error';
    case 'operational':
    default:
      return 'border-success/30 bg-success/10 text-success';
  }
}

function StatusChip({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="inline-flex min-h-8 items-center gap-2 rounded-lg border border-hairline bg-canvas/70 px-3 text-[12px] font-medium text-ink shadow-sm">
      <span className="text-primary">{icon}</span>
      {label}
    </span>
  );
}

function StatusSkeleton() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {[0, 1, 2, 3].map((item) => (
        <div
          key={item}
          className="h-28 animate-pulse rounded-lg border border-hairline bg-surface-card"
        />
      ))}
    </div>
  );
}

function ServiceStatusCard({
  service,
}: {
  service: PublicStatusService;
}) {
  const { t } = useI18n();
  const Icon = SERVICE_ICONS[service.key];
  const toneClass = statusToneClass(service.status);

  return (
    <section className="rounded-lg border border-hairline bg-surface-raised p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Icon size={18} />
          </div>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink">
              {t(`pages.status.services.${service.key}.label`)}
            </h2>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              {t(`pages.status.services.${service.key}.description`)}
            </p>
          </div>
        </div>
        <span
          className={`inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold ${toneClass}`}
        >
          <CheckCircle2 size={12} aria-hidden="true" />
          {t(statusLabelKey(service.status))}
        </span>
      </div>
    </section>
  );
}

/**
 * 渲染公开系统状态页面。
 *
 * @returns 面向普通用户的轻量服务可用性视图。
 */
export function StatusWorkspace() {
  const { t, formatDate } = useI18n();
  const [statusData, setStatusData] = useState<PublicStatusOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    setRefreshing(true);
    setLoadFailed(false);
    try {
      setStatusData(await billingApi.publicStatus());
    } catch {
      setStatusData(null);
      setLoadFailed(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const overallStatus: PublicStatusLevel = loadFailed
    ? 'degraded'
    : (statusData?.overall_status ?? 'operational');
  const updatedAt = formatStatusTime(
    statusData?.updated_at ?? null,
    t('pages.status.waitingSync'),
    formatDate,
  );

  return (
    <AppShell wide requireAuth={false}>
      <div className="min-h-[70vh] space-y-4">
        <section className="rounded-2xl border border-hairline bg-surface-raised p-5 shadow-raised">
          <div className="grid gap-5 md:grid-cols-[1fr_auto] md:items-end">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex min-h-8 items-center gap-2 rounded-lg border px-3 text-[12px] font-semibold ${statusToneClass(overallStatus)}`}
                >
                  <Server size={14} />
                  {t(statusLabelKey(overallStatus))}
                </span>
                <StatusChip
                  icon={<Clock3 size={13} />}
                  label={t('pages.status.lastChecked', { time: updatedAt })}
                />
              </div>

              <h1 className="mt-5 text-[30px] font-semibold leading-tight tracking-tight text-ink md:text-[44px]">
                {t('pages.status.title')}
              </h1>
              <p className="mt-2 max-w-2xl text-[14px] leading-6 text-muted">
                {t('pages.status.description')}
              </p>
            </div>

            <button
              type="button"
              onClick={() => void load(false)}
              disabled={refreshing}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-primary/25 bg-primary/10 px-4 text-[13px] font-semibold text-primary transition-colors hover:border-primary/45 hover:bg-primary/16 disabled:cursor-not-allowed disabled:opacity-55"
            >
              {refreshing ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <RefreshCw size={14} />
              )}
              {refreshing
                ? t('pages.status.refreshing')
                : t('pages.status.refresh')}
            </button>
          </div>
        </section>

        {loadFailed && (
          <div className="rounded-lg border border-error/30 bg-error/8 px-4 py-3 text-[12px] text-error">
            {t('pages.status.loadFailed')}
          </div>
        )}

        {loading ? (
          <StatusSkeleton />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {(statusData?.services ?? []).map((service) => (
              <ServiceStatusCard key={service.key} service={service} />
            ))}
            {statusData?.services.length === 0 && (
              <section className="rounded-lg border border-hairline bg-surface-card p-4 text-[13px] text-muted md:col-span-2">
                {t('pages.status.noServices')}
              </section>
            )}
          </div>
        )}

        <section className="rounded-lg border border-hairline bg-surface-card/80 p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
              <ShieldCheck size={16} />
            </div>
            <div>
              <h2 className="text-[14px] font-semibold text-ink">
                {t('pages.status.noticeTitle')}
              </h2>
              <p className="mt-1 text-[12px] leading-5 text-muted">
                {t('pages.status.noticeDescription')}
              </p>
            </div>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
