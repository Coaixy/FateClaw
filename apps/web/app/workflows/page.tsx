'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  History,
  Loader2,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  Workflow as WorkflowIcon,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { workflowsApi, type WorkflowDefinition } from '@/features/workflows/api';
import { ApiError } from '@/lib/http/client';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';
import { useConfirm } from '@/lib/use-confirm';

/** 统计某工作流的节点构成,用于卡片摘要。 */
function nodeSummary(workflow: WorkflowDefinition): {
  total: number;
  paipan: number;
  ai: number;
} {
  let paipan = 0;
  let ai = 0;
  for (const node of workflow.graph.nodes) {
    if (node.type === 'paipan') paipan += 1;
    else if (node.type === 'ai') ai += 1;
  }
  return { total: workflow.graph.nodes.length, paipan, ai };
}

export default function WorkflowsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { t } = useI18n();
  const { toast } = useToast();
  const { confirm } = useConfirm();

  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [search, setSearch] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // 从客户详情"用工作流断"进来时带 ?client=,运行链接会把它透传给运行页(排盘步用其生辰预填)。
  const [clientId, setClientId] = useState<string | undefined>(undefined);
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('client');
    setClientId(value ?? undefined);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await workflowsApi.list();
      setWorkflows(res.workflows);
    } catch (error) {
      if (error instanceof ApiError) {
        toast('error', error.message);
      } else {
        toast('error', t('workflows.loadError'));
      }
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    load().finally(() => {
      if (!cancelled) setInitialLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [user, load]);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return workflows;
    return workflows.filter(
      (workflow) =>
        workflow.name.toLowerCase().includes(keyword) ||
        workflow.description.toLowerCase().includes(keyword),
    );
  }, [workflows, search]);

  const handleDelete = useCallback(
    async (workflow: WorkflowDefinition) => {
      const ok = await confirm({
        title: t('workflows.deleteTitle'),
        message: t('workflows.deleteMessage', { name: workflow.name }),
        confirmLabel: t('workflows.deleteConfirm'),
        variant: 'danger',
      });
      if (!ok) return;
      setDeletingId(workflow.id);
      try {
        await workflowsApi.remove(workflow.id);
        setWorkflows((prev) => prev.filter((item) => item.id !== workflow.id));
        toast('success', t('workflows.deleted'));
      } catch (error) {
        toast(
          'error',
          error instanceof ApiError ? error.message : t('workflows.loadError'),
        );
      } finally {
        setDeletingId(null);
      }
    },
    [confirm, t, toast],
  );

  const showSkeleton = loading && !initialLoaded;

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-8">
        {/* Header */}
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-ink">
              {t('workflows.title')}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {t('workflows.description')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => router.push('/workflows/new')}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-opacity hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            {t('workflows.new')}
          </button>
        </header>

        {clientId && (
          <div className="rounded-xl border border-primary/25 bg-primary/5 px-4 py-2.5 text-[12px] text-primary">
            {t('workflows.pickForClient')}
          </div>
        )}

        <section className="space-y-3">
          {showSkeleton ? (
            <ListSkeleton />
          ) : workflows.length === 0 ? (
            <EmptyState
              title={t('workflows.empty.title')}
              description={t('workflows.empty.description')}
              actionLabel={t('workflows.new')}
              onAction={() => router.push('/workflows/new')}
            />
          ) : (
            <>
              <div className="relative">
                <Search
                  size={15}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
                />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t('workflows.search')}
                  className="h-10 w-full rounded-xl border border-hairline bg-surface-card pl-9 pr-3 text-[13px] text-ink placeholder:text-muted focus:border-primary focus:outline-none"
                />
              </div>

              {filtered.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-hairline py-10 text-center">
                  <p className="text-[12px] text-muted">
                    {t('workflows.noResults', { query: search.trim() })}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {filtered.map((workflow) => (
                    <WorkflowCard
                      key={workflow.id}
                      workflow={workflow}
                      deleting={deletingId === workflow.id}
                      onRun={() =>
                        router.push(
                          `/workflows/run?id=${encodeURIComponent(workflow.id)}${
                            clientId
                              ? `&client=${encodeURIComponent(clientId)}`
                              : ''
                          }`,
                        )
                      }
                      onRuns={() =>
                        router.push(
                          `/workflows/runs?id=${encodeURIComponent(workflow.id)}`,
                        )
                      }
                      onEdit={() =>
                        router.push(
                          `/workflows/edit?id=${encodeURIComponent(workflow.id)}`,
                        )
                      }
                      onDelete={() => handleDelete(workflow)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </AppShell>
  );
}

function WorkflowCard({
  workflow,
  deleting,
  onRun,
  onRuns,
  onEdit,
  onDelete,
}: {
  workflow: WorkflowDefinition;
  deleting: boolean;
  onRun: () => void;
  onRuns: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const summary = nodeSummary(workflow);

  return (
    <div className="group rounded-2xl border border-hairline bg-surface-card p-4 transition-colors hover:border-primary/25">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={onEdit}
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
        >
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <WorkflowIcon size={17} strokeWidth={1.8} />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate text-[15px] font-semibold text-ink">
                {workflow.name}
              </span>
              {!workflow.enabled && (
                <span className="shrink-0 rounded-md border border-hairline px-1.5 py-0.5 text-[10px] font-medium text-muted">
                  {t('workflows.disabledBadge')}
                </span>
              )}
            </span>
            {workflow.description && (
              <span className="mt-1 line-clamp-2 block text-[12px] leading-relaxed text-muted">
                {workflow.description}
              </span>
            )}
            <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted/80">
              <span>{t('workflows.nodesCount', { count: summary.total })}</span>
              <span>
                {t('workflows.builder.paipanBadge')} × {summary.paipan} ·{' '}
                {t('workflows.builder.aiBadge')} × {summary.ai}
              </span>
            </span>
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onRun}
            disabled={!workflow.enabled}
            className="mr-1 inline-flex h-8 items-center gap-1 rounded-lg border border-primary/25 bg-primary/8 px-2.5 text-[12px] font-medium text-primary hover:bg-primary/15 disabled:opacity-40"
          >
            <Play size={13} />
            {t('workflows.runAction')}
          </button>
          <button
            type="button"
            onClick={onRuns}
            aria-label={t('workflows.runs.title')}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-cream-strong hover:text-ink"
          >
            <History size={14} />
          </button>
          <button
            type="button"
            onClick={onEdit}
            aria-label={t('workflows.edit')}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-cream-strong hover:text-ink"
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            aria-label={t('workflows.delete')}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-error/10 hover:text-error disabled:opacity-40"
          >
            {deleting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Trash2 size={14} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="animate-pulse rounded-2xl border border-hairline bg-surface-card p-4"
        >
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 shrink-0 rounded-xl bg-muted/10" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-32 rounded-full bg-muted/12" />
              <div className="h-3 w-48 rounded-full bg-muted/10" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-hairline py-14 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-hairline bg-surface-card">
        <WorkflowIcon size={20} className="text-muted" />
      </div>
      <p className="max-w-[18rem] text-[14px] font-medium text-ink">{title}</p>
      <p className="mt-1.5 max-w-[22rem] text-[12px] text-muted">
        {description}
      </p>
      <button
        type="button"
        onClick={onAction}
        className="mt-5 inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-semibold text-on-primary hover:opacity-90"
      >
        <Plus size={13} />
        {actionLabel}
      </button>
    </div>
  );
}
