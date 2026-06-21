'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Clock, Loader2, User } from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import {
  workflowsApi,
  type WorkflowDefinition,
  type WorkflowRunSummary,
} from '@/features/workflows/api';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';

/** 把 ISO 时间转成本地可读字符串;解析失败回退原串。 */
function formatRunTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function WorkflowRunsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { t } = useI18n();
  const { toast } = useToast();

  const workflowId = params.get('id') ?? '';
  const [workflow, setWorkflow] = useState<WorkflowDefinition | null>(null);
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workflowId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [def, runList] = await Promise.all([
          workflowsApi.get(workflowId),
          workflowsApi.listRuns(workflowId),
        ]);
        if (cancelled) return;
        setWorkflow(def);
        setRuns(runList.runs);
      } catch {
        if (!cancelled) toast('error', t('workflows.loadError'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflowId, t, toast]);

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1.5">
        <button
          type="button"
          onClick={() => router.push('/workflows')}
          className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink"
        >
          <ArrowLeft size={13} /> {t('workflows.runs.back')}
        </button>
        <h1 className="text-2xl font-bold tracking-tight text-ink">
          {t('workflows.runs.title')}
        </h1>
        {workflow && <p className="text-sm text-muted">{workflow.name}</p>}
      </header>

      {runs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-hairline py-14 text-center text-[12px] text-muted">
          {t('workflows.runs.empty')}
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => (
            <button
              key={run.sessionId}
              type="button"
              onClick={() =>
                router.push(
                  `/workflows/run?id=${encodeURIComponent(
                    workflowId,
                  )}&view=${encodeURIComponent(run.sessionId)}`,
                )
              }
              className="flex w-full items-center gap-3 rounded-xl border border-hairline bg-surface-card px-4 py-3 text-left transition-colors hover:border-primary/25"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Clock size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-ink">
                  {formatRunTime(run.startedAt)}
                </span>
                {run.clientId && (
                  <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
                    <User size={11} /> {t('workflows.runs.withClient')}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function WorkflowRunsPage() {
  return (
    <AppShell>
      <Suspense
        fallback={
          <div className="flex min-h-[40vh] items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted" />
          </div>
        }
      >
        <WorkflowRunsInner />
      </Suspense>
    </AppShell>
  );
}
