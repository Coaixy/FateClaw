import { getContext } from './context.js';
import type { RequestScope } from './request-scope.js';
import {
  appendScopedTraceEvent,
  getRequestId,
  markRequestActivity,
} from './request-scope.js';
import type { TraceEventEntry } from './types.js';

/**
 * Emit request traces to stderr and the persisted conversation trace buffer.
 * Warnings and errors retain their severity in the host; routine events use debug.
 */
export function traceEvent(
  event: Record<string, unknown>,
  scope?: RequestScope,
): void {
  let accountId: string | undefined;
  try {
    accountId = getContext().accountId;
  } catch {
    accountId = undefined;
  }

  const entry: TraceEventEntry = {
    accountId,
    requestId: scope ? getRequestId(scope) : undefined,
    timestamp: new Date().toISOString(),
    ...event,
    // 保证 type 和 timestamp 覆盖不被调用方意外覆写的字段占用
    type: typeof event.type === 'string' ? event.type : 'unknown',
  };

  const level =
    event.level === 'warn' || event.level === 'error' ? event.level : 'debug';
  process.stderr.write(`[trace:${level}] ${JSON.stringify(entry)}\n`);

  // 2. 请求缓冲通道（DB 排障）
  if (scope) {
    try {
      markRequestActivity(scope);
      appendScopedTraceEvent(scope, entry);
    } catch {
      // 缓冲失败不影响 stderr 通道（防御性：极端情况下不让可观测性拖垮主流程）
    }
  }
}
