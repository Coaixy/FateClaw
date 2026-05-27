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
  latestFollowupInterpretation: FollowupInterpretationContext | null;
}

const TRACE_EVENT_MAX_BYTES = 16 * 1024;
const TRACE_FIELD_TRUNCATE_BYTES = 4 * 1024;
const TRACE_MAX_COUNT = 500;
const TRACE_MAX_TOTAL_BYTES = 200 * 1024;

export function createRequestScope(): RequestScope {
  return {
    requestId: undefined,
    traceEvents: [],
    traceEventsTotalBytes: 0,
    traceOverflowReported: false,
    transcript: [],
    artifacts: [],
    latestFollowupInterpretation: null,
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
