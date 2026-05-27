import { resolveEvidenceCategoryBySkill } from '../evidence-policy.js';
import { createAgentGraphBuilder } from '../agent-graph.js';
import { getRequestId } from '../request-scope.js';
import type {
  Artifact,
  SkillContextEntry,
  TokenUsage,
} from '../types.js';
import { traceEvent } from '../trace.js';
import { runPiSession } from './session.js';
import type {
  PiRuntimeInput,
  PiRuntimeResult,
  PiToolExecutionRecord,
} from './types.js';

function emptyUsage(): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
}

function mergeSkillContext(records: PiToolExecutionRecord[]): SkillContextEntry[] {
  const entries: SkillContextEntry[] = [];
  for (const record of records) {
    const entry = record.skillContextEntry;
    if (!entry) continue;
    const exists = entries.some(
      (item) => item.skill === entry.skill && item.output === entry.output,
    );
    if (!exists) {
      entries.push(entry);
    }
  }
  return entries;
}

function isInterpretTool(toolName: string): boolean {
  return toolName === 'interpret_xuanxue';
}

function isBoardTool(record: PiToolExecutionRecord): boolean {
  const skill = record.skillContextEntry?.skill;
  if (!skill) return false;
  return Boolean(resolveEvidenceCategoryBySkill(skill));
}

function artifactsForSkill(args: {
  artifacts: Artifact[];
  skill: string | undefined;
}): Artifact[] {
  if (!args.skill) return [];
  return args.artifacts.filter((artifact) => artifact.producer === args.skill);
}

export async function executePiRuntime(
  args: PiRuntimeInput,
): Promise<PiRuntimeResult> {
  const requestId =
    getRequestId(args.requestScope) ||
    args.requestScope.requestId ||
    `request-${Date.now()}`;
  const graphBuilder = createAgentGraphBuilder({
    requestId,
    containerInput: args.containerInput,
  });

  traceEvent({ type: 'pi_runtime_started' }, args.requestScope);

  const result = await runPiSession({
    containerInput: args.containerInput,
    runtime: args.runtime,
    requestScope: args.requestScope,
  });
  const skillContext = mergeSkillContext(result.records);

  for (const record of result.records) {
    if (record.invocation.toolName === 'final_reply') continue;
    if (!record.skillContextEntry && !isInterpretTool(record.invocation.toolName)) {
      continue;
    }
    const specialist = isInterpretTool(record.invocation.toolName)
      ? 'xuanxue-interpret-agent'
      : isBoardTool(record)
        ? 'xuanxue-board-agent'
        : 'general-assistant';
    const skill = record.skillContextEntry?.skill;
    graphBuilder.addSpecialistTask({
      specialist,
      source: 'supervisor',
      goal: record.invocation.toolName,
      category: skill ? resolveEvidenceCategoryBySkill(skill) ?? undefined : undefined,
      outputPreview: record.modelOutput ?? record.output,
      artifacts: artifactsForSkill({
        artifacts: args.requestScope.artifacts,
        skill,
      }),
    });
  }

  graphBuilder.addFinalReply(result.text);
  traceEvent(
    {
      type: 'pi_runtime_completed',
      textLength: result.text?.length ?? 0,
      totalSkillContext: skillContext.length,
      toolCallCount: result.records.length,
    },
    args.requestScope,
  );

  return {
    text: result.text,
    usage: result.usage ?? emptyUsage(),
    skillContext,
    agentGraph: graphBuilder.build(),
  };
}
