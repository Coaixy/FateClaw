'use client';

import { AppShell } from '@/components/app-shell';
import { WorkflowBuilder } from '@/components/workflows/workflow-builder';

export default function NewWorkflowPage() {
  return (
    <AppShell>
      <WorkflowBuilder mode="create" />
    </AppShell>
  );
}
