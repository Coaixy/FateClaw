import type { AgentToolResult } from '@earendil-works/pi-coding-agent';

import { appendTranscriptEvent } from '#agent/transcript-store';
import { traceEvent } from '#agent/trace';
import type { RequestScope } from '#agent/request-scope';
import type { PiToolExecutionRecord } from '#agent/pi-runtime/types';

/**
 * Pi 工具运行时依赖。
 *
 * 参数：
 * - requestScope：当前请求作用域，用于写入 transcript 和 trace。
 * - recordExecution：工具执行记录回调，用于后续生成 skillContext/agentGraph。
 *
 * 注意：这里只承接确定性工具的公共运行时依赖，不处理具体业务参数校验。
 */
export interface PiToolRuntimeOptions {
  requestScope: RequestScope;
  recordExecution(record: PiToolExecutionRecord): void;
}

/**
 * 完成一次 Pi 工具调用并同步写入运行记录。
 *
 * 参数：
 * - options：工具运行时依赖。
 * - toolCallId：Pi 侧本次工具调用 id。
 * - toolName：工具名称。
 * - params：模型传入的工具参数。
 * - output：返回给模型的文本结果。
 * - details：结构化结果，供内部调试和单测使用。
 * - isError：本次调用是否失败。
 * - traceType：写入 trace 的事件类型。
 * - startedAt：工具开始时间戳，用于记录耗时。
 * - traceFields：追加到 trace 的业务字段。
 *
 * 返回：Pi coding agent 需要的 AgentToolResult。
 */
export function completePiToolExecution<TDetails extends { output: string }>({
  options,
  toolCallId,
  toolName,
  params,
  output,
  details,
  isError,
  traceType,
  startedAt,
  traceFields,
}: {
  options: PiToolRuntimeOptions;
  toolCallId: string;
  toolName: string;
  params: Record<string, unknown>;
  output: string;
  details: TDetails;
  isError: boolean;
  traceType: string;
  startedAt: number;
  traceFields?: Record<string, unknown>;
}): AgentToolResult<TDetails> {
  options.recordExecution({
    invocation: {
      id: toolCallId,
      toolName,
      args: params,
    },
    output,
    isError,
  });
  appendTranscriptEvent(options.requestScope, {
    type: 'tool_use',
    invocation: {
      id: toolCallId,
      toolName,
      args: params,
      source: 'model',
    },
  });
  appendTranscriptEvent(options.requestScope, {
    type: 'tool_result',
    invocationId: toolCallId,
    ok: !isError,
    output,
  });
  traceEvent(
    {
      type: traceType,
      elapsedMs: Date.now() - startedAt,
      isError,
      ...traceFields,
    },
    options.requestScope,
  );

  traceEvent(
    {
      type: 'agent_timing',
      stage: 'tool',
      durationMs: Date.now() - startedAt,
      toolName,
      outputBytes: Buffer.byteLength(output, 'utf8'),
    },
    options.requestScope,
  );

  return {
    content: [{ type: 'text', text: output }],
    details,
  };
}

/**
 * 为单次工具调用创建收尾器。
 *
 * 固化本次 execute 内不变的参数（options/toolCallId/toolName/params/traceType/startedAt），
 * 各分支只需 respond(details, traceFields)，isError 直接取 details.isError，
 * 省去在校验失败/成功/异常多个分支里重复传同一批固定参数。
 *
 * 参数：base —— 本次工具调用的固定上下文。
 * 返回：收尾函数；传入的 details 必须自带已序列化好的 output 字段。
 */
export function makeToolResponder(base: {
  options: PiToolRuntimeOptions;
  toolCallId: string;
  toolName: string;
  params: Record<string, unknown>;
  traceType: string;
  startedAt: number;
}) {
  return <TDetails extends { output: string; isError: boolean }>(
    details: TDetails,
    traceFields?: Record<string, unknown>,
  ): AgentToolResult<TDetails> =>
    completePiToolExecution({
      options: base.options,
      toolCallId: base.toolCallId,
      toolName: base.toolName,
      params: base.params,
      output: details.output,
      details,
      isError: details.isError,
      traceType: base.traceType,
      startedAt: base.startedAt,
      traceFields,
    });
}
