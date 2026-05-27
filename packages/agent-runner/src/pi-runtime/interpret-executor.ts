import { withExplicitInterpretContent } from '../interpret-content-injection.js';
import { appendTranscriptEvent } from '../transcript-store.js';
import { traceEvent } from '../trace.js';
import { executeInterpretXuanxue } from '../tools/skill/interpret-xuanxue.js';
import type {
  SkillContextEntry,
  ToolExecutionOptions,
  ToolInvocation,
  ToolResult,
} from '../types.js';
import type { PiToolRunResult } from './types.js';

const INTERPRET_SKILL = 'xuanxue-jiedu';

function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildInterpretSkillContextEntry(output: string): SkillContextEntry {
  return {
    skill: INTERPRET_SKILL,
    output,
    artifactType: `skill.${INTERPRET_SKILL}`,
    artifactTitle: `Skill 结果: ${INTERPRET_SKILL}`,
    artifactData: parseJsonSafe(output),
  };
}

function appendPiInterpretObservability(args: {
  invocation: ToolInvocation;
  result: ToolResult;
  options: ToolExecutionOptions;
}): void {
  const requestScope = args.options.requestScope;
  if (!requestScope) return;

  const ok = !args.result.isError;
  appendTranscriptEvent(requestScope, {
    type: 'tool_result',
    invocationId: args.invocation.id,
    ok,
    output: args.result.output,
    modelOutput: args.result.modelOutput,
    errorCode: args.result.error?.code,
  });

  traceEvent({
    type: 'tool_result',
    toolName: args.invocation.toolName,
    isError: !ok,
    errorCode: args.result.error?.code,
    output: args.result.output.slice(0, 200),
    modelOutputPreview: args.result.modelOutput?.slice(0, 2000),
    modelOutputBytes:
      args.result.modelOutput !== undefined
        ? Buffer.byteLength(args.result.modelOutput, 'utf8')
        : undefined,
    source: args.invocation.source,
  }, requestScope);
}

export async function executePiInterpretTool(args: {
  invocation: ToolInvocation;
  options: ToolExecutionOptions;
}): Promise<PiToolRunResult> {
  if (!args.options.requestScope) {
    throw new Error('executePiInterpretTool 缺少 requestScope');
  }

  const invocation = withExplicitInterpretContent(
    args.invocation,
    args.options.requestScope,
    args.options,
  );
  appendTranscriptEvent(args.options.requestScope, {
    type: 'tool_use',
    invocation,
  });
  traceEvent({
    type: 'tool_call',
    toolName: invocation.toolName,
    args: invocation.args,
    source: invocation.source,
    piDirectExecutor: true,
  }, args.options.requestScope);

  const result = await executeInterpretXuanxue(invocation.args, args.options);
  const skillContextEntry =
    !result.isError && !result.skipArtifact
      ? buildInterpretSkillContextEntry(result.output)
      : undefined;

  appendPiInterpretObservability({
    invocation,
    result,
    options: args.options,
  });

  return {
    result,
    skillContextEntry,
  };
}
