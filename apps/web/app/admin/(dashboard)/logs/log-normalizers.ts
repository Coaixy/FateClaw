import {
  AgentTaskGraph,
  ConversationLog,
  TraceEventEntry,
  TranscriptEvent,
} from '@/lib/admin-api';

import { isRecord, toText, toTokenNumber } from './log-utils';

export function normalizeTraceEvents(value: unknown): TraceEventEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((event) => ({
      ...event,
      type: typeof event.type === 'string' ? event.type : 'unknown',
      timestamp: typeof event.timestamp === 'string' ? event.timestamp : '',
    }));
}

export function normalizeTranscript(value: unknown): TranscriptEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((event) => {
    const type =
      event.type === 'assistant' ||
      event.type === 'tool_use' ||
      event.type === 'tool_result'
        ? event.type
        : undefined;
    if (!type) return [];

    return [{
      ...event,
      type,
      text: toText(event.text),
      output: event.output === undefined ? undefined : toText(event.output),
      modelOutput:
        event.modelOutput === undefined ? undefined : toText(event.modelOutput),
      invocation: isRecord(event.invocation)
        ? {
            id: toText(event.invocation.id),
            toolName: toText(event.invocation.toolName) || 'unknown_tool',
            args: isRecord(event.invocation.args) ? event.invocation.args : {},
            displayTitle:
              event.invocation.displayTitle === undefined
                ? undefined
                : toText(event.invocation.displayTitle),
          }
        : undefined,
    } as TranscriptEvent];
  });
}

export function normalizeAgentGraph(value: unknown): AgentTaskGraph | null {
  if (!isRecord(value)) return null;
  const summary = isRecord(value.summary) ? value.summary : {};
  const tasks = Array.isArray(value.tasks)
    ? value.tasks.filter(isRecord).map((task) => ({
        id: toText(task.id) || 'unknown-task',
        kind: task.kind === 'root' ? 'root' : 'specialist',
        status:
          task.status === 'completed' ||
          task.status === 'running' ||
          task.status === 'blocked' ||
          task.status === 'failed'
            ? task.status
            : 'completed',
        source: task.source === 'runtime_guard' ? 'runtime_guard' : 'supervisor',
        specialist: task.specialist === undefined ? undefined : toText(task.specialist),
        goal: toText(task.goal),
        category: task.category === undefined ? undefined : toText(task.category),
        startedAt: toText(task.startedAt),
        completedAt: task.completedAt === undefined ? undefined : toText(task.completedAt),
        outputPreview:
          task.outputPreview === undefined ? undefined : toText(task.outputPreview),
      }))
    : [];
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.filter(isRecord).map((item) => ({
        id: toText(item.id) || 'unknown-evidence',
        source:
          item.source === 'history' ||
          item.source === 'artifact' ||
          item.source === 'final_reply'
            ? item.source
            : 'artifact',
        category: item.category === undefined ? undefined : toText(item.category),
        producer: item.producer === undefined ? undefined : toText(item.producer),
        title: toText(item.title) || '未命名产出',
        contentPreview: toText(item.contentPreview),
        createdAt: toText(item.createdAt),
        artifactId: item.artifactId === undefined ? undefined : toText(item.artifactId),
        payload: item.payload,
      }))
    : [];
  const edges = Array.isArray(value.edges)
    ? value.edges.filter(isRecord).map((edge) => ({
        id: toText(edge.id) || 'unknown-edge',
        fromNodeId: toText(edge.fromNodeId),
        toNodeId: toText(edge.toNodeId),
        relation:
          edge.relation === 'uses' ||
          edge.relation === 'delegates' ||
          edge.relation === 'produces' ||
          edge.relation === 'responds_with'
            ? edge.relation
            : 'uses',
      }))
    : [];

  return {
    ...value,
    version: 1,
    requestId: toText(value.requestId),
    accountId: toText(value.accountId),
    sessionId: value.sessionId === undefined ? undefined : toText(value.sessionId),
    rootTaskId: toText(value.rootTaskId),
    tasks,
    evidence,
    edges,
    summary: {
      category: summary.category === undefined ? undefined : toText(summary.category),
      needsBoard: summary.needsBoard === true,
      needsInterpretation: summary.needsInterpretation === true,
      usedRuntimeGuards: summary.usedRuntimeGuards === true,
      specialistSequence: Array.isArray(summary.specialistSequence)
        ? summary.specialistSequence.map(toText)
        : [],
      taskCount: toTokenNumber(summary.taskCount),
      evidenceCount: toTokenNumber(summary.evidenceCount),
      finalTextPreview:
        summary.finalTextPreview === undefined
          ? undefined
          : toText(summary.finalTextPreview),
    },
  } as AgentTaskGraph;
}

export function normalizeConversationLog(log: ConversationLog): ConversationLog {
  return {
    ...log,
    transcript: normalizeTranscript(log.transcript),
    trace_events: normalizeTraceEvents(log.trace_events),
    agent_graph: normalizeAgentGraph(log.agent_graph),
    capability_ledger: log.capability_ledger ?? null,
  };
}
