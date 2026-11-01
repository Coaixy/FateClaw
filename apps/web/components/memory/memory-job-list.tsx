'use client';

import type { MemoryJobDto, MemoryStatusDto } from '@fateclaw/contracts/memory';
import { Loader2, Pause, Play, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

export function MemoryJobList({
  status,
  loading,
  error,
  pending,
  onRefresh,
  onJobAction,
}: {
  status: MemoryStatusDto | null;
  loading: boolean;
  error: string;
  pending: string;
  onRefresh: () => void;
  onJobAction: (job: MemoryJobDto, action: 'pause' | 'resume') => void;
}) {
  const { t, formatNumber, formatDate } = useI18n();

  return (
    <section
      className="rounded-2xl border border-hairline bg-surface-card/60 p-4 sm:p-5"
      aria-label={t('memory.jobsTitle')}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold">{t('memory.jobsTitle')}</h2>
        <Button
          variant="ghost"
          size="sm"
          loading={loading}
          disabled={Boolean(pending)}
          icon={<RefreshCw size={13} />}
          onClick={onRefresh}
        >
          {t('memory.refresh')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-error">
          {error}
        </p>
      )}
      {!status && !loading && !error && (
        <p className="mt-3 text-[12px] text-muted">
          {t('memory.statusUnavailable')}
        </p>
      )}
      {status && (
        <>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-muted">
            <span>
              {t('memory.activeCount', {
                count: formatNumber(status.active_items),
              })}
            </span>
            <span>
              {t('memory.pendingCount', {
                count: formatNumber(status.pending_jobs),
              })}
            </span>
            <span className={status.failed_jobs ? 'text-error' : ''}>
              {t('memory.failedCount', {
                count: formatNumber(status.failed_jobs),
              })}
            </span>
          </div>
          <p className="mt-2 text-[11px] leading-5 text-muted">
            {t('memory.pendingExplanation')}
          </p>
          {status.recent_jobs.length > 0 ? (
            <ul className="mt-3 divide-y divide-hairline/60">
              {status.recent_jobs.map((job) => (
                <li
                  key={job.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 text-[12px]"
                >
                  <div className="min-w-0 flex-1 basis-40">
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{t(`memory.jobKinds.${job.kind}`)}</span>
                      <span
                        className={
                          job.state === 'failed' ? 'text-error' : 'text-muted'
                        }
                      >
                        {job.state === 'running' && (
                          <Loader2
                            size={11}
                            className="mr-1 inline animate-spin"
                          />
                        )}
                        {t(`memory.jobStates.${job.state}`)}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-muted">
                      {formatNumber(job.processed_count)}
                      {job.total_count === null
                        ? ''
                        : ` / ${formatNumber(job.total_count)}`}
                      <span className="mx-2">·</span>
                      {formatDate(job.updated_at, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                      {job.error_code && (
                        <span className="ml-2 break-all text-error">
                          {job.error_code}
                        </span>
                      )}
                    </p>
                  </div>
                  {job.kind === 'backfill' &&
                    (job.state === 'pending' ||
                      job.state === 'running' ||
                      job.state === 'paused') && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={Boolean(pending)}
                        loading={pending === `job:${job.id}`}
                        icon={
                          job.state === 'paused' ? (
                            <Play size={12} />
                          ) : (
                            <Pause size={12} />
                          )
                        }
                        onClick={() =>
                          onJobAction(
                            job,
                            job.state === 'paused' ? 'resume' : 'pause',
                          )
                        }
                      >
                        {t(
                          job.state === 'paused'
                            ? 'memory.resume'
                            : 'memory.pause',
                        )}
                      </Button>
                    )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[12px] text-muted">{t('memory.noJobs')}</p>
          )}
        </>
      )}
    </section>
  );
}
