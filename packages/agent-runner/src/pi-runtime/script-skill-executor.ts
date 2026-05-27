import { appendArtifact } from '../artifact-store.js';
import { resolveEvidenceCategoryBySkill } from '../evidence-policy.js';
import {
  recordProducedEvidence,
  type RequestScope,
} from '../request-scope.js';
import {
  formatBoardForAi,
  hasBoardFormatter,
} from '../tools/skill/board-formatters/index.js';
import { appendTranscriptEvent } from '../transcript-store.js';
import { traceEvent } from '../trace.js';
import type {
  Artifact,
  SkillContextEntry,
  ToolExecutionOptions,
  ToolInvocation,
  ToolResult,
} from '../types.js';
import type { PiDeterministicScriptToolSpec } from './deterministic-tool-catalog.js';
import { executePiDeterministicScript } from './deterministic-script-executor.js';
import type { PiToolRunResult } from './types.js';

function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildSkillArtifact(args: {
  skillName: string;
  output: string;
  title?: string;
}): Artifact {
  return {
    id: `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: `skill.${args.skillName}`,
    title: args.title || `Skill 结果: ${args.skillName}`,
    producer: args.skillName,
    category: resolveEvidenceCategoryBySkill(args.skillName) ?? undefined,
    payload: parseJsonSafe(args.output),
    rawOutput: args.output,
    createdAt: new Date().toISOString(),
  };
}

function buildSkillContextEntry(artifact: Artifact): SkillContextEntry {
  return {
    skill: artifact.producer,
    output: artifact.rawOutput,
    artifactType: artifact.type,
    artifactTitle: artifact.title,
    artifactData: artifact.payload,
  };
}

function appendPiScriptSkillObservability(args: {
  requestScope: RequestScope;
  invocation: ToolInvocation;
  result: ToolResult;
  artifact?: Artifact;
}): void {
  const ok = !args.result.isError;
  appendTranscriptEvent(args.requestScope, {
    type: 'tool_result',
    invocationId: args.invocation.id,
    ok,
    output: args.result.output,
    modelOutput: args.result.modelOutput,
    artifactId: args.artifact?.id,
    errorCode: args.result.error?.code,
  });

  traceEvent(
    {
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
      artifactType: args.artifact?.type,
      source: args.invocation.source,
    },
    args.requestScope,
  );
}

export async function executePiScriptSkillTool(args: {
  invocation: ToolInvocation;
  spec: PiDeterministicScriptToolSpec;
  params: Record<string, unknown>;
  options: ToolExecutionOptions;
}): Promise<PiToolRunResult> {
  if (!args.options.requestScope) {
    throw new Error('executePiScriptSkillTool 缺少 requestScope');
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
    },
    requestScope,
  );

  const result = await executePiDeterministicScript({
    spec: args.spec,
    params: args.params,
    options: args.options,
  });

  const artifact =
    !result.isError && !result.skipArtifact
      ? appendArtifact(
          requestScope,
          buildSkillArtifact({
            skillName: args.spec.skillName,
            output: result.output,
            title:
              args.invocation.displayTitle ?? args.invocation.artifactHint?.title,
          }),
        )
      : undefined;

  if (artifact && hasBoardFormatter(artifact.producer)) {
    result.modelOutput = formatBoardForAi({
      skill: artifact.producer,
      output: artifact.rawOutput,
      artifactData: artifact.payload,
    });
  }
  const skillContextEntry =
    artifact && !result.isError ? buildSkillContextEntry(artifact) : undefined;
  if (artifact?.category) {
    recordProducedEvidence(requestScope, artifact.category, artifact.producer);
  }

  appendPiScriptSkillObservability({
    requestScope,
    invocation: args.invocation,
    result,
    artifact,
  });
  return {
    result,
    artifact,
    skillContextEntry,
  };
}
