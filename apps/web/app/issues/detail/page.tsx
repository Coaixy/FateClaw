import { Suspense } from 'react';
import { IssueDetailWorkspace } from '@/components/issues/issue-detail-workspace';

export default function IssueDetailPage() {
  return (
    <Suspense
      fallback={<p className="p-8 text-sm text-muted">正在加载讨论…</p>}
    >
      <IssueDetailWorkspace />
    </Suspense>
  );
}
