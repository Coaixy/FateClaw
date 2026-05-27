import { appendTranscriptEvent } from '../transcript-store.js';
import { traceEvent } from '../trace.js';
import { throwIfAborted } from '../timeout.js';
import type {
  ToolExecutionOptions,
  ToolInvocation,
  ToolSpec,
} from '../types.js';
import type { PiToolRunResult } from './types.js';

export async function executePiDirectTool(args: {
  invocation: ToolInvocation;
  spec: ToolSpec;
  options: ToolExecutionOptions;
}): Promise<PiToolRunResult> {
  if (!args.options.requestScope) {
    throw new Error('executePiDirectTool 缺少 requestScope');
  }

  const requestScope = args.options.requestScope;
  throwIfAborted(
    args.options.signal,
    `工具 ${args.invocation.toolName} 已取消`,
  );
  appendTranscriptEvent(requestScope, {
    type: 'tool_use',
    invocation: args.invocation,
  });
  traceEvent(
    {
      type: 'tool_call',
      toolName: args.invocation.toolName,
      args: args.invocation.args,
      source: args.invocation.source,
      piDirectExecutor: true,
    },
    requestScope,
  );

  const result = await args.spec.execute(args.invocation.args, args.options);
  throwIfAborted(
    args.options.signal,
    `工具 ${args.invocation.toolName} 已取消`,
  );

  const ok = !result.isError;
  appendTranscriptEvent(requestScope, {
    type: 'tool_result',
    invocationId: args.invocation.id,
    ok,
    output: result.output,
    modelOutput: result.modelOutput,
    errorCode: result.error?.code,
  });
  traceEvent(
    {
      type: 'tool_result',
      toolName: args.invocation.toolName,
      isError: !ok,
      errorCode: result.error?.code,
      output: result.output.slice(0, 200),
      modelOutputPreview: result.modelOutput?.slice(0, 2000),
      modelOutputBytes:
        result.modelOutput !== undefined
          ? Buffer.byteLength(result.modelOutput, 'utf8')
          : undefined,
      source: args.invocation.source,
      piDirectExecutor: true,
    },
    requestScope,
  );

  return { result };
}
