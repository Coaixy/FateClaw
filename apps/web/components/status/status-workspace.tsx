'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  Clock3,
  Cpu,
  Gauge,
  LoaderCircle,
  MessageSquareText,
  RadioTower,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Users,
  Zap,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { billingApi, type PublicStatusStats } from '@/features/billing/api';
import { useI18n } from '@/lib/i18n';

type TokenUsagePoint = PublicStatusStats['token_usage_series'][number];
type NumberFormatter = ReturnType<typeof useI18n>['formatNumber'];
type DateFormatter = ReturnType<typeof useI18n>['formatDate'];

function formatCompactNumber(
  value: number,
  formatNumber: NumberFormatter,
): string {
  if (value < 10000) {
    return formatNumber(value);
  }

  return formatNumber(value, {
    notation: 'compact',
    maximumFractionDigits: value < 100000000 ? 1 : 2,
  });
}

function formatStatusTime(
  date: Date | null,
  fallback: string,
  formatDate: DateFormatter,
): string {
  if (!date) {
    return fallback;
  }

  return formatDate(date, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * 平台状态工作台，展示公开运行指标和最近 Token 消耗趋势。
 */
export function StatusWorkspace() {
  const { t, formatDate, formatNumber } = useI18n();
  const [stats, setStats] = useState<PublicStatusStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    setRefreshing(true);
    setLoadFailed(false);
    try {
      setStats(await billingApi.publicStatus());
      setUpdatedAt(new Date());
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  return (
    <AppShell wide requireAuth={false}>
      <div className="min-h-[70vh] space-y-4">
        <StatusHero
          loading={loading}
          refreshing={refreshing}
          loadFailed={loadFailed}
          updatedAt={updatedAt}
          todayTokens={stats?.today_total_tokens ?? 0}
          formatDate={formatDate}
          formatNumber={formatNumber}
          onRefresh={() => void load(false)}
        />

        {loadFailed && (
          <div className="rounded-lg border border-error/30 bg-error/8 px-4 py-3 text-[12px] text-error">
            {t('pages.status.loadFailed')}
          </div>
        )}

        {loading ? (
          <StatusSkeleton />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-3">
              <StatusCard
                icon={<MessageSquareText size={16} />}
                label={t('pages.status.todayMessagesLabel')}
                code={t('pages.status.todayMessagesCode')}
                value={formatCompactNumber(stats?.today_messages ?? 0, formatNumber)}
                caption={t('pages.status.todayMessagesCaption')}
              />
              <StatusCard
                icon={<LoaderCircle size={16} />}
                label={t('pages.status.processingLabel')}
                code={t('pages.status.processingCode')}
                value={formatCompactNumber(
                  stats?.processing_sessions ?? 0,
                  formatNumber,
                )}
                caption={t('pages.status.processingCaption')}
              />
              <StatusCard
                icon={<Users size={16} />}
                label={t('pages.status.registeredUsersLabel')}
                code={t('pages.status.registeredUsersCode')}
                value={formatCompactNumber(
                  stats?.registered_users ?? 0,
                  formatNumber,
                )}
                caption={t('pages.status.registeredUsersCaption')}
              />
              <StatusCard
                icon={<Sparkles size={16} />}
                label={t('pages.status.todayTokensLabel')}
                code={t('pages.status.todayTokensCode')}
                value={formatCompactNumber(
                  stats?.today_total_tokens ?? 0,
                  formatNumber,
                )}
                caption={t('pages.status.todayTokensCaption')}
              />
            </div>
            <TokenUsagePanel stats={stats} formatNumber={formatNumber} />
          </>
        )}
      </div>
    </AppShell>
  );
}

function StatusHero({
  loading,
  refreshing,
  loadFailed,
  updatedAt,
  todayTokens,
  formatDate,
  formatNumber,
  onRefresh,
}: {
  loading: boolean;
  refreshing: boolean;
  loadFailed: boolean;
  updatedAt: Date | null;
  todayTokens: number;
  formatDate: DateFormatter;
  formatNumber: NumberFormatter;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const statusLabel = loadFailed
    ? t('pages.status.stateDegraded')
    : loading
      ? t('pages.status.stateConnecting')
      : t('pages.status.stateOnline');
  const statusText = loadFailed
    ? t('pages.status.signalError')
    : loading
      ? t('pages.status.signalLoading')
      : t('pages.status.signalOnline');

  return (
    <section className="relative overflow-hidden rounded-lg border border-primary/20 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--color-surface-card)_88%,var(--color-canvas)),color-mix(in_srgb,var(--color-surface-soft)_70%,var(--color-canvas)))] shadow-[0_18px_48px_rgba(15,23,42,0.1)]">
      <div
        className="pointer-events-none absolute inset-0 opacity-35"
        aria-hidden="true"
      >
        <div className="absolute inset-0 bg-[linear-gradient(to_right,color-mix(in_srgb,var(--color-ink)_6%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_srgb,var(--color-ink)_6%,transparent)_1px,transparent_1px)] bg-[size:32px_32px]" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent" />
      </div>

      <div className="relative grid gap-3 p-3 sm:p-4 md:grid-cols-[1fr_280px] md:p-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-primary/35 bg-primary/15 px-2.5 text-[11px] font-semibold text-primary">
              <RadioTower size={13} />
              {t('pages.status.liveBadge')}
            </span>
            <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-hairline bg-canvas/65 px-2.5 text-[11px] text-muted shadow-sm">
              <Clock3 size={12} />
              {formatStatusTime(
                updatedAt,
                t('pages.status.waitingSync'),
                formatDate,
              )}
            </span>
          </div>

          <h1 className="mt-3 text-[22px] font-semibold leading-tight tracking-tight text-ink sm:text-[28px] md:mt-4 md:text-[40px]">
            {t('pages.status.title')}
          </h1>
          <p className="mt-1.5 hidden max-w-2xl text-[13px] leading-6 text-muted sm:block md:mt-2 md:text-[14px]">
            {t('pages.status.description')}
          </p>

          <div className="mt-3 flex flex-wrap gap-1.5 md:mt-4 md:gap-2">
            <StatusChip icon={<ShieldCheck size={13} />} label={statusLabel} />
            <StatusChip
              icon={<Zap size={13} />}
              label={t('pages.status.todayTokensChip', {
                tokens: formatCompactNumber(todayTokens, formatNumber),
              })}
            />
          </div>
        </div>

        <div className="rounded-lg border border-hairline/70 bg-canvas/62 p-2.5 shadow-sm md:p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">
                {t('pages.status.signalLabel')}
              </div>
              <div className="mt-1 text-[13px] font-semibold text-ink">
                {statusText}
              </div>
            </div>
            <div className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-primary/35 bg-primary/12 text-primary shadow-sm md:h-12 md:w-12">
              <span className="absolute h-5 w-5 animate-ping rounded-full bg-primary/25" />
              <Activity size={18} />
            </div>
          </div>

          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-primary/25 bg-primary/10 px-3 text-[12px] font-semibold text-primary transition-colors hover:border-primary/45 hover:bg-primary/16 disabled:cursor-not-allowed disabled:opacity-55 md:mt-4 md:h-10"
          >
            <RefreshCw
              size={13}
              className={refreshing ? 'animate-spin text-primary' : ''}
            />
            {refreshing
              ? t('pages.status.refreshing')
              : t('pages.status.refresh')}
          </button>
        </div>
      </div>
    </section>
  );
}

function StatusChip({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-hairline bg-canvas/65 px-2 text-[10px] font-medium text-ink shadow-sm sm:h-8 sm:px-2.5 sm:text-[11px]">
      <span className="text-primary">{icon}</span>
      {label}
    </span>
  );
}

function StatusSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-3">
      {[0, 1, 2, 3].map((item) => (
        <div
          key={item}
          className="h-28 animate-pulse rounded-lg border border-hairline bg-surface-card md:h-36"
        />
      ))}
    </div>
  );
}

function StatusCard({
  icon,
  label,
  code,
  value,
  caption,
}: {
  icon: ReactNode;
  label: string;
  code: string;
  value: string;
  caption: string;
}) {
  return (
    <section className="group rounded-lg border border-hairline bg-[linear-gradient(180deg,color-mix(in_srgb,var(--color-surface-card)_72%,transparent),color-mix(in_srgb,var(--color-canvas)_58%,transparent))] p-2.5 shadow-[0_10px_28px_rgba(15,23,42,0.04)] transition-colors hover:border-primary/30 sm:p-3 md:p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary sm:h-9 sm:w-9">
          {icon}
        </div>
        <span className="rounded border border-hairline bg-surface-card/60 px-1.5 py-0.5 font-mono text-[9px] text-muted">
          {code}
        </span>
      </div>
      <div className="text-[11px] font-medium leading-4 text-muted md:text-[12px]">
        {label}
      </div>
      <div className="mt-1 text-xl font-extrabold tracking-tight tabular-nums sm:text-2xl md:text-3xl">
        {value}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted/75 sm:mt-2">
        <Gauge size={11} className="text-primary" />
        {caption}
      </div>
    </section>
  );
}

function formatShortDate(date: string): string {
  const [, month, day] = date.split('-');
  return `${Number(month)}.${Number(day)}`;
}

function sortTokenUsageByDate(
  rows: TokenUsagePoint[],
  direction: 'asc' | 'desc',
): TokenUsagePoint[] {
  return [...rows].sort((a, b) =>
    direction === 'asc'
      ? a.date.localeCompare(b.date)
      : b.date.localeCompare(a.date),
  );
}

function TokenUsagePanel({
  stats,
  formatNumber,
}: {
  stats: PublicStatusStats | null;
  formatNumber: NumberFormatter;
}) {
  const { t } = useI18n();
  const rows = stats?.token_usage_series ?? [];
  // 过滤无实际消耗的日期，避免 0 Token 记录占用趋势图和明细表空间。
  const tokenRows = rows.filter((row) => row.total_tokens > 0);
  // 图表保留旧到新的趋势轴，表格按最新日期优先展示。
  const chartRows = sortTokenUsageByDate(tokenRows, 'asc');
  const tableRows = sortTokenUsageByDate(tokenRows, 'desc');
  const maxTokens = Math.max(1, ...chartRows.map((row) => row.total_tokens));
  const totalTokens = tokenRows.reduce((sum, row) => sum + row.total_tokens, 0);
  const peakRow =
    chartRows.length > 0
      ? chartRows.reduce((peak, row) =>
          row.total_tokens > peak.total_tokens ? row : peak,
        )
      : null;

  return (
    <section className="rounded-lg border border-hairline bg-surface-card/80 p-3 shadow-[0_10px_28px_rgba(15,23,42,0.04)] md:p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            <Cpu size={14} className="text-primary" />
            {t('pages.status.telemetryTitle')}
          </div>
          <div className="mt-0.5 text-[11px] text-muted">
            {t('pages.status.telemetryDescription')}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1.5 text-[10px] text-muted sm:flex sm:items-center sm:gap-2">
          <TelemetryPill
            label={t('pages.status.sevenDayTotal')}
            value={formatCompactNumber(totalTokens, formatNumber)}
          />
          <TelemetryPill
            label={t('pages.status.peak')}
            value={
              peakRow
                ? formatCompactNumber(peakRow.total_tokens, formatNumber)
                : '—'
            }
          />
        </div>
      </div>

      {tokenRows.length === 0 ? (
        <div className="flex h-36 items-center justify-center rounded-lg border border-hairline bg-canvas/45 px-4 text-[12px] text-muted md:h-48">
          {t('pages.status.noTokenRecords')}
        </div>
      ) : (
        <>
          <div className="relative flex h-32 items-end gap-2 overflow-hidden rounded-lg border border-hairline bg-[linear-gradient(to_bottom,color-mix(in_srgb,var(--color-surface-card)_72%,var(--color-canvas)),color-mix(in_srgb,var(--color-canvas)_86%,var(--color-surface-soft)))] px-2 pb-8 pt-3 sm:h-40 md:h-56 md:gap-3 md:px-4 md:pt-4">
            <div
              className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,color-mix(in_srgb,var(--color-ink)_6%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_srgb,var(--color-ink)_6%,transparent)_1px,transparent_1px)] bg-[size:32px_32px]"
              aria-hidden="true"
            />
            {chartRows.map((row) => {
              const totalHeight = Math.max(
                6,
                Math.round((row.total_tokens / maxTokens) * 100),
              );
              const inputRatio = row.input_tokens / row.total_tokens;
              return (
                <div
                  key={row.date}
                  className="relative z-[1] flex h-full min-w-0 flex-1 items-end justify-center"
                >
                  <div
                    className="flex w-full max-w-10 flex-col-reverse overflow-hidden rounded-t-md border border-ink/10 bg-hairline/70 shadow-[0_0_22px_rgba(204,120,92,0.16)]"
                    style={{ height: `${totalHeight}%` }}
                    title={t('pages.status.chartBarTitle', {
                      date: row.date,
                      tokens: formatCompactNumber(row.total_tokens, formatNumber),
                    })}
                  >
                    <div
                      className="bg-primary"
                      style={{ height: `${Math.max(0, Math.round(inputRatio * 100))}%` }}
                    />
                    <div className="flex-1 bg-accent-teal" />
                  </div>
                  <div className="absolute top-[calc(100%+6px)] text-[10px] text-muted">
                    {formatShortDate(row.date)}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3 text-[10px] text-muted">
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-primary" />
              {t('pages.status.inputToken')}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-accent-teal" />
              {t('pages.status.outputToken')}
            </span>
          </div>

          <div className="mt-3 grid gap-1.5 sm:hidden">
            {tableRows.slice(0, 4).map((row) => (
              <div
                key={row.date}
                className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-hairline bg-canvas/45 px-3 py-2 text-[11px]"
              >
                <div className="font-mono text-muted">{row.date}</div>
                <div className="text-right font-semibold tabular-nums text-ink">
                  {formatCompactNumber(row.total_tokens, formatNumber)}
                </div>
                <div className="text-muted">
                  {t('pages.status.inputTokenValue', {
                    tokens: formatCompactNumber(row.input_tokens, formatNumber),
                  })}
                </div>
                <div className="text-right text-muted">
                  {t('pages.status.outputTokenValue', {
                    tokens: formatCompactNumber(row.output_tokens, formatNumber),
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 hidden overflow-x-auto rounded-lg border border-hairline bg-canvas/35 sm:block">
            <table className="w-full min-w-[480px] text-left text-[11px]">
              <thead className="text-muted">
                <tr className="border-b border-hairline">
                  <th className="px-3 py-2 font-medium">
                    {t('pages.status.date')}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t('pages.status.inputToken')}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t('pages.status.outputToken')}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t('pages.status.total')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((row) => (
                  <tr key={row.date} className="border-b border-hairline/50 last:border-0">
                    <td className="px-3 py-2 font-mono text-muted">
                      {row.date}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatCompactNumber(row.input_tokens, formatNumber)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatCompactNumber(row.output_tokens, formatNumber)}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">
                      {formatCompactNumber(row.total_tokens, formatNumber)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function TelemetryPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex h-7 items-center justify-between gap-2 rounded-lg border border-hairline bg-canvas/55 px-2.5 text-[10px]">
      <span>{label}</span>
      <span className="font-semibold tabular-nums text-ink">{value}</span>
    </span>
  );
}
