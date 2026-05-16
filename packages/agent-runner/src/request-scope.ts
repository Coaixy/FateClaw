import type {
  Artifact,
  TraceEventEntry,
  TranscriptEvent,
} from './types.js';

export interface FollowupInterpretationContext {
  category: string;
  interpretationOutput: string;
  boardSkill?: string;
  boardOutput?: string;
  boardArtifactData?: unknown;
}

export interface RequestScope {
  requestId?: string;
  traceEvents: TraceEventEntry[];
  traceEventsTotalBytes: number;
  traceOverflowReported: boolean;
  transcript: TranscriptEvent[];
  artifacts: Artifact[];
  pendingSoulContent: string | null;
  sentProgressKeys: Set<string>;
  loadedSkills: Set<string>;
  executedSkillScripts: Set<string>;
  producedEvidence: Map<string, string>;
  latestFollowupInterpretation: FollowupInterpretationContext | null;
  outboundMessageCount: number;
  sendMessageCount: number;
}

const TRACE_EVENT_MAX_BYTES = 16 * 1024;
const TRACE_FIELD_TRUNCATE_BYTES = 4 * 1024;
const TRACE_MAX_COUNT = 500;
const TRACE_MAX_TOTAL_BYTES = 200 * 1024;
const MAX_OUTBOUND_MESSAGES = 9;

export function createRequestScope(): RequestScope {
  return {
    requestId: undefined,
    traceEvents: [],
    traceEventsTotalBytes: 0,
    traceOverflowReported: false,
    transcript: [],
    artifacts: [],
    pendingSoulContent: null,
    sentProgressKeys: new Set(),
    loadedSkills: new Set(),
    executedSkillScripts: new Set(),
    producedEvidence: new Map(),
    latestFollowupInterpretation: null,
    outboundMessageCount: 0,
    sendMessageCount: 0,
  };
}

function truncateStringFields(value: unknown): unknown {
  if (typeof value === 'string') {
    const byteLen = Buffer.byteLength(value, 'utf8');
    if (byteLen <= TRACE_FIELD_TRUNCATE_BYTES) return value;
    const ratio = TRACE_FIELD_TRUNCATE_BYTES / byteLen;
    const cut = Math.floor(value.length * ratio);
    return value.slice(0, cut) + `...[truncated ${byteLen - TRACE_FIELD_TRUNCATE_BYTES} bytes]`;
  }
  if (Array.isArray(value)) {
    return value.map((v) => truncateStringFields(v));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateStringFields(v);
    }
    return out;
  }
  return value;
}

export function appendScopedTraceEvent(
  scope: RequestScope,
  event: TraceEventEntry,
): void {
  if (scope.traceEvents.length >= TRACE_MAX_COUNT) {
    if (!scope.traceOverflowReported) {
      scope.traceOverflowReported = true;
      scope.traceEvents.push({
        type: 'trace_overflow',
        timestamp: new Date().toISOString(),
        reason: 'count_limit',
        limit: TRACE_MAX_COUNT,
      });
    }
    return;
  }

  let finalEvent = event;
  let serialized = JSON.stringify(event);
  if (serialized.length > TRACE_EVENT_MAX_BYTES) {
    finalEvent = truncateStringFields(event) as TraceEventEntry;
    serialized = JSON.stringify(finalEvent);
  }

  if (scope.traceEventsTotalBytes + serialized.length > TRACE_MAX_TOTAL_BYTES) {
    if (!scope.traceOverflowReported) {
      scope.traceOverflowReported = true;
      scope.traceEvents.push({
        type: 'trace_overflow',
        timestamp: new Date().toISOString(),
        reason: 'size_limit',
        totalBytes: scope.traceEventsTotalBytes,
        limit: TRACE_MAX_TOTAL_BYTES,
      });
    }
    return;
  }

  scope.traceEvents.push(finalEvent);
  scope.traceEventsTotalBytes += serialized.length;
}

export function listScopedTraceEvents(scope: RequestScope): TraceEventEntry[] {
  return [...scope.traceEvents];
}

export function setRequestId(scope: RequestScope, requestId?: string): void {
  scope.requestId = requestId;
}

export function getRequestId(scope: RequestScope): string | undefined {
  return scope.requestId;
}

export function getPendingSoulContent(scope: RequestScope): string | null {
  return scope.pendingSoulContent;
}

export function setPendingSoulContent(
  scope: RequestScope,
  content: string,
): void {
  scope.pendingSoulContent = content;
}

export function canSendOutbound(scope: RequestScope): boolean {
  return scope.outboundMessageCount < MAX_OUTBOUND_MESSAGES;
}

export function incrementOutbound(scope: RequestScope): void {
  scope.outboundMessageCount += 1;
}

export function canSendIntermediateMessage(scope: RequestScope): boolean {
  return scope.sendMessageCount < 3;
}

export function incrementSendMessage(scope: RequestScope): void {
  scope.sendMessageCount += 1;
}

export function hasProgressKey(scope: RequestScope, key: string): boolean {
  return scope.sentProgressKeys.has(key);
}

export function addProgressKey(scope: RequestScope, key: string): void {
  scope.sentProgressKeys.add(key);
}

export function markSkillLoaded(scope: RequestScope, skillName: string): void {
  scope.loadedSkills.add(skillName);
}

export function hasLoadedSkill(scope: RequestScope, skillName: string): boolean {
  return scope.loadedSkills.has(skillName);
}

function buildSkillScriptExecutionKey(args: {
  loopIteration?: number;
  loopRunId?: string;
  skillName: string;
  script: string;
}): string {
  // 去重只收敛到“同一个 loop 实例的同一轮 + 同一 skill/script 一次”。
  // 这样 supervisor / specialist 即使共享 requestScope，也不会因为各自第 1 轮碰撞。
  const iteration = args.loopIteration ?? 0;
  const loopRunId = args.loopRunId ?? 'default-loop';
  return `${loopRunId}:${iteration}:${args.skillName}/${args.script}`;
}

export function hasExecutedSkillScript(
  scope: RequestScope,
  skillName: string,
  script: string,
  options?: {
    loopIteration?: number;
    loopRunId?: string;
  },
): boolean {
  return scope.executedSkillScripts.has(
    buildSkillScriptExecutionKey({
      loopIteration: options?.loopIteration,
      loopRunId: options?.loopRunId,
      skillName,
      script,
    }),
  );
}

export function markSkillScriptExecuted(
  scope: RequestScope,
  skillName: string,
  script: string,
  options?: {
    loopIteration?: number;
    loopRunId?: string;
  },
): void {
  scope.executedSkillScripts.add(
    buildSkillScriptExecutionKey({
      loopIteration: options?.loopIteration,
      loopRunId: options?.loopRunId,
      skillName,
      script,
    }),
  );
}

export function recordProducedEvidence(
  scope: RequestScope,
  category: string,
  skillName: string,
): void {
  scope.producedEvidence.set(category, skillName);
}

export function hasProducedEvidence(
  scope: RequestScope,
  category: string,
  skillName?: string,
): boolean {
  const actual = scope.producedEvidence.get(category);
  if (!actual) return false;
  return skillName ? actual === skillName : true;
}

export function setLatestFollowupInterpretation(
  scope: RequestScope,
  context: FollowupInterpretationContext | null,
): void {
  scope.latestFollowupInterpretation = context;
}

export function getLatestFollowupInterpretation(
  scope: RequestScope,
): FollowupInterpretationContext | null {
  return scope.latestFollowupInterpretation;
}
