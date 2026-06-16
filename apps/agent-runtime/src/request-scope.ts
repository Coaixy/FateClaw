import type { Artifact, TraceEventEntry, TranscriptEvent } from './types.js';

export interface RequestScope {
  requestId?: string;
  traceEvents: TraceEventEntry[];
  traceEventsTotalBytes: number;
  traceOverflowReported: boolean;
  transcript: TranscriptEvent[];
  artifacts: Artifact[];
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
  };
}

function backtrackUnsafeUtf16Boundary(value: string, cut: number): number {
  if (cut <= 0 || cut >= value.length) return cut;
  const previous = value.charCodeAt(cut - 1);
  const next = value.charCodeAt(cut);
  // JS string 以 UTF-16 code unit 存储；截断点不能落在代理对中间。
  if (previous >= 0xd800 && previous <= 0xdbff) return cut - 1;
  if (next >= 0xdc00 && next <= 0xdfff) return cut - 1;
  return cut;
}

function sliceUtf8ByByteLimit(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), 'utf8') <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const cut = backtrackUnsafeUtf16Boundary(value, low);
  return value.slice(0, cut);
}

export function truncateStringFields(value: unknown): unknown {
  if (typeof value === 'string') {
    const byteLen = Buffer.byteLength(value, 'utf8');
    if (byteLen <= TRACE_FIELD_TRUNCATE_BYTES) return value;
    const suffix = `...[truncated ${byteLen - TRACE_FIELD_TRUNCATE_BYTES} bytes]`;
    const prefixLimit = Math.max(
      0,
      TRACE_FIELD_TRUNCATE_BYTES - Buffer.byteLength(suffix, 'utf8'),
    );
    return sliceUtf8ByByteLimit(value, prefixLimit) + suffix;
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
