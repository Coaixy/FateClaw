import { getContext } from './context.js';
import type { RequestScope } from './request-scope.js';
import {
  appendScopedTraceEvent,
  getRequestId,
  markRequestActivity,
} from './request-scope.js';
import type { TraceEventEntry } from './types.js';

/**
 * 将 trace 事件双路派发：
 * 1. JSON 写入 stderr（`[trace:debug]` 前缀），供开发期实时观测；
 *    宿主 local-runner.ts 按前缀降级为 debug 日志，生产不刷屏。
 * 2. 追加到 request-state 的 trace 缓冲，请求结束时经 ContainerOutput
 *    回传宿主机落库到 conversation_logs.trace_events 供 admin 排障。
 *
 * 本函数不落盘本地文件，避免无限增长的小文件堆积。
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

  // 1. stderr 通道（dev 实时观测）
  process.stderr.write(`[trace:debug] ${JSON.stringify(entry)}\n`);

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
