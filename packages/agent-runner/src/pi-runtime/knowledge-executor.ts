import { appendTranscriptEvent } from '../transcript-store.js';
import { traceEvent } from '../trace.js';
import {
  executeXuanxueKnowledgeTool,
} from '../tools/skill/xuanxue-knowledge-tools.js';
import type {
  ToolExecutionOptions,
  ToolInvocation,
} from '../types.js';
import type { PiToolRunResult } from './types.js';

type PiKnowledgeToolName =
  | 'list_knowledge_sections'
  | 'read_knowledge_section';

export async function executePiKnowledgeTool(args: {
  invocation: ToolInvocation;
  options: ToolExecutionOptions;
}): Promise<PiToolRunResult> {
  if (!args.options.requestScope) {
    throw new Error('executePiKnowledgeTool 缺少 requestScope');
  }

  const requestScope = args.options.requestScope;
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

  const result = await executeXuanxueKnowledgeTool(
    args.invocation.toolName as PiKnowledgeToolName,
    args.invocation.args,
    args.options,
  );
  const ok = !result.isError;
  appendTranscriptEvent(requestScope, {
    type: 'tool_result',
    invocationId: args.invocation.id,
    ok,
    output: result.output,
    errorCode: result.error?.code,
  });
  traceEvent(
    {
      type: 'tool_result',
      toolName: args.invocation.toolName,
      isError: !ok,
      errorCode: result.error?.code,
      output: result.output.slice(0, 200),
      source: args.invocation.source,
      piDirectExecutor: true,
    },
    requestScope,
  );

  return { result };
}
