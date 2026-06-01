import { createAgentGraphBuilder } from '../agent-graph.js';
import { getRequestId } from '../request-scope.js';
import type { SkillContextEntry, TokenUsage } from '../types.js';
import { traceEvent } from '../trace.js';
import { runPiSession } from './session.js';
import { mergePiPersistedSkillContext } from './context-layer.js';
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
    onSessionReady: args.onSessionReady,
  });
  const runtimeSkillContext = mergeSkillContext(result.records);
  const skillContext = mergePiPersistedSkillContext({
    persistedSkillContext: result.persistedSkillContext ?? [],
    runtimeSkillContext,
  });

  for (const record of result.records) {
    if (!record.skillContextEntry) {
      continue;
    }
    const skill = record.skillContextEntry?.skill;
    graphBuilder.addSpecialistTask({
      specialist: 'general-assistant',
      source: 'supervisor',
      goal: record.invocation.toolName,
      outputPreview: record.modelOutput ?? record.output,
      artifacts: args.requestScope.artifacts.filter(
        (artifact) => artifact.producer === skill,
      ),
    });
  }

  graphBuilder.addAssistantReply(result.text);
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
    piSession: result.piSession,
  };
}
