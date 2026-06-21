'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { AppShell } from '@/components/app-shell';
import { WorkflowBuilder } from '@/components/workflows/workflow-builder';
import {
  workflowsApi,
  type WorkflowDefinition,
} from '@/features/workflows/api';
import { useI18n } from '@/lib/i18n';

function CenterSpinner() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-transparent" />
    </div>
  );
}

function EditWorkflowInner() {
  const params = useSearchParams();
  const id = params.get('id') ?? '';
  const { t } = useI18n();
  const [workflow, setWorkflow] = useState<WorkflowDefinition | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'notfound'>(
    'loading',
  );

  useEffect(() => {
    if (!id) {
      setState('notfound');
      return;
    }
    let cancelled = false;
    workflowsApi
      .get(id)
      .then((data) => {
        if (cancelled) return;
        setWorkflow(data);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('notfound');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (state === 'loading') return <CenterSpinner />;
  if (state === 'notfound' || !workflow) {
    return (
      <div className="mx-auto max-w-3xl py-16 text-center text-sm text-muted">
        {t('workflows.notFound')}
      </div>
    );
  }
  return (
    <WorkflowBuilder mode="edit" workflowId={workflow.id} initial={workflow} />
  );
}

export default function EditWorkflowPage() {
  return (
    <AppShell>
      <Suspense fallback={<CenterSpinner />}>
        <EditWorkflowInner />
      </Suspense>
    </AppShell>
  );
}
