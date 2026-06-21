'use client';

import dynamic from 'next/dynamic';

import { AppShell } from '@/components/app-shell';

// React Flow 画布依赖浏览器 API(ResizeObserver 等),仅客户端渲染。
const WorkflowBuilder = dynamic(
  () =>
    import('@/components/workflows/workflow-builder').then(
      (module) => module.WorkflowBuilder,
    ),
  { ssr: false, loading: () => <BuilderFallback /> },
);

function BuilderFallback() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-transparent" />
    </div>
  );
}

export default function NewWorkflowPage() {
  return (
    <AppShell wide>
      <WorkflowBuilder mode="create" />
    </AppShell>
  );
}
