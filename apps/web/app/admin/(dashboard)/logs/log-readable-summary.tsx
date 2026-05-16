'use client';

import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  GitBranch,
  Layers3,
  MessageSquare,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';

import type {
  AgentTaskGraph,
  ConversationLog,
  TraceEventEntry,
} from '@/lib/admin-api';

import { formatTime } from './log-utils';

const TASK_STATUS_META: Record<
  string,
  { label: string; className: string; icon: LucideIcon }
> = {
  completed: {
    label: '完成',
    className: 'text-emerald-300 bg-emerald-500/10',
    icon: CheckCircle2,
  },
  running: {
    label: '运行中',
    className: 'text-sky-300 bg-sky-500/10',
    icon: Bot,
  },
  blocked: {
    label: '阻塞',
    className: 'text-amber-300 bg-amber-500/10',
    icon: AlertTriangle,
  },
  failed: {
    label: '失败',
    className: 'text-red-300 bg-red-500/10',
    icon: AlertTriangle,
  },
};

function getTraceEvent(
  events: TraceEventEntry[] | null | undefined,
  type: string,
): TraceEventEntry | null {
  return events?.find((event) => event.type === type) ?? null;
}

function clipText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}...`;
}

function countTaskEvidence(graph: AgentTaskGraph | null, taskId: string): number {
  if (!graph) return 0;
  return graph.edges.filter(
    (edge) => edge.relation === 'produces' && edge.fromNodeId === taskId,
  ).length;
}

function getTaskEvidenceTitles(graph: AgentTaskGraph | null, taskId: string): string[] {
  if (!graph) return [];
  const evidenceIds = new Set(
    graph.edges
      .filter((edge) => edge.relation === 'produces' && edge.fromNodeId === taskId)
      .map((edge) => edge.toNodeId),
  );
  return graph.evidence
    .filter((item) => evidenceIds.has(item.id))
    .map((item) => item.title)
    .slice(0, 3);
}

function ReadableTextBlock({
  label,
  text,
  tone = 'neutral',
}: {
  label: string;
  text: string;
  tone?: 'neutral' | 'blue' | 'purple' | 'emerald' | 'amber';
}) {
  const toneClass =
    tone === 'blue'
      ? 'border-blue-500/20 bg-blue-500/5 text-blue-200'
      : tone === 'purple'
        ? 'border-purple-500/20 bg-purple-500/5 text-purple-200'
        : tone === 'emerald'
          ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-200'
          : tone === 'amber'
            ? 'border-amber-500/20 bg-amber-500/5 text-amber-200'
            : 'border-hairline bg-canvas text-ink';

  return (
    <div className={`rounded-md border px-3 py-2 ${toneClass}`}>
      <div className="text-[10px] uppercase tracking-wider text-muted">
        {label}
      </div>
      <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed">
        {text}
      </pre>
    </div>
  );
}

function SpecialistTaskRow({
  graph,
  task,
}: {
  graph: AgentTaskGraph | null;
  task: AgentTaskGraph['tasks'][number];
}) {
  const status = TASK_STATUS_META[task.status] ?? TASK_STATUS_META.completed;
  const StatusIcon = status.icon;
  const evidenceCount = countTaskEvidence(graph, task.id);
  const evidenceTitles = getTaskEvidenceTitles(graph, task.id);

  return (
    <div className="border-t border-hairline py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Bot size={13} className="text-muted shrink-0" />
          <span className="text-[12px] font-medium text-ink truncate">
            {task.specialist || 'supervisor'}
          </span>
        </div>
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${status.className}`}>
          <StatusIcon size={10} />
          {status.label}
        </span>
        {task.category && (
          <span className="inline-flex items-center gap-1 rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-200">
            <Sparkles size={10} />
            {task.category}
          </span>
        )}
        <span className="text-[10px] font-mono text-muted">
          {evidenceCount} 份证据
        </span>
      </div>

      <div className="mt-2 space-y-2">
        <ReadableTextBlock
          label="任务产出"
          text={task.outputPreview || '暂无可读产出'}
          tone="emerald"
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted">
        <span className="font-mono">
          {formatTime(task.startedAt)}
        </span>
        {task.completedAt && (
          <span className="font-mono">
            {formatTime(task.completedAt)}
          </span>
        )}
        {evidenceTitles.length > 0 && (
          <span className="inline-flex flex-wrap items-center gap-1">
            <Layers3 size={10} />
            {evidenceTitles.map((title) => (
              <span
                key={title}
                className="rounded bg-surface-cream-strong px-1.5 py-0.5 text-ink"
              >
                {clipText(title, 22)}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

export function ReadableLogSummary({
  log,
}: {
  log: ConversationLog;
}) {
  const graph = log.agent_graph;
  const summary = graph?.summary ?? log.agent_graph_summary;
  const requestStart = getTraceEvent(log.trace_events, 'request_start');
  const rootTask = graph?.tasks.find((task) => task.kind === 'root') ?? null;
  const specialistTasks =
    graph?.tasks.filter((task) => task.kind === 'specialist') ?? [];
  const specialistSequence = summary?.specialistSequence ?? [];
  const promptPreview =
    (typeof requestStart?.promptPreview === 'string'
      ? requestStart.promptPreview
      : '') || rootTask?.goal || '';

  if (!summary && !graph && !promptPreview) return null;

  const provider = typeof requestStart?.provider === 'string'
    ? requestStart.provider
    : log.provider || '';
  const model = typeof requestStart?.model === 'string'
    ? requestStart.model
    : log.model || '';

  return (
    <div className="mt-2 rounded-lg border border-hairline bg-surface-cream-strong/55 p-3">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <GitBranch size={13} className="text-muted" />
        <span className="font-medium text-ink">可读摘要</span>
        {summary?.category && (
          <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-200">
            {summary.category}
          </span>
        )}
        {summary?.usedRuntimeGuards && (
          <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-300">
            runtime guard
          </span>
        )}
        {summary?.needsBoard && (
          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-200">
            need board
          </span>
        )}
        {summary?.needsInterpretation && (
          <span className="rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] text-purple-200">
            need interpret
          </span>
        )}
        {provider && model && (
          <span className="font-mono text-[10px] text-muted">
            {provider}/{model}
          </span>
        )}
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-3">
        <div className="rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2">
          <div className="text-[11px] text-blue-300">请求 prompt</div>
          <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[12px] text-ink">
            {clipText(promptPreview, 900)}
          </pre>
        </div>
        <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
          <div className="text-[11px] text-emerald-300">Specialist 路径</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {specialistSequence.length > 0 ? (
              specialistSequence.map((name) => (
                <span
                  key={name}
                  className="rounded bg-canvas px-1.5 py-0.5 text-[11px] text-ink"
                >
                  {name}
                </span>
              ))
            ) : (
              <span className="text-[12px] text-muted">无</span>
            )}
          </div>
        </div>
        <div className="rounded-md border border-purple-500/20 bg-purple-500/5 px-3 py-2">
          <div className="text-[11px] text-purple-300">任务概览</div>
          <div className="mt-1 text-[12px] text-ink">
            {summary ? `${summary.taskCount} 个 task · ${summary.evidenceCount} 份证据` : '暂无 graph'}
          </div>
        </div>
      </div>

      {rootTask && (
        <div className="mt-3 rounded-md border border-hairline bg-canvas/40 px-3 py-2">
          <div className="flex items-center gap-1.5 text-[11px] text-muted">
            <MessageSquare size={11} />
            <span>用户原始请求</span>
          </div>
          <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink">
            {rootTask.goal}
          </pre>
        </div>
      )}

      {specialistTasks.length > 0 && (
        <div className="mt-3 rounded-md border border-hairline bg-canvas/40 px-3">
          {specialistTasks.map((task) => (
            <SpecialistTaskRow key={task.id} graph={graph} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}
