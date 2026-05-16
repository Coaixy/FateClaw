import type {
  AgentEvidenceNode,
  AgentGraphEdge,
  AgentGraphSummary,
  AgentTaskGraph,
  AgentTaskNode,
  Artifact,
  ContainerInput,
  HistoryMessage,
} from '../types.js';
import type { SpecialistName } from './types.js';

function makeEdge(
  fromNodeId: string,
  toNodeId: string,
  relation: AgentGraphEdge['relation'],
): AgentGraphEdge {
  return {
    id: `edge-${relation}-${fromNodeId}-${toNodeId}`,
    fromNodeId,
    toNodeId,
    relation,
  };
}

function collectHistoryEvidence(history: HistoryMessage[]): AgentEvidenceNode[] {
  const nodes: AgentEvidenceNode[] = [];
  let index = 0;

  for (const message of history.slice(-6)) {
    for (const entry of message.toolContext ?? []) {
      index += 1;
      nodes.push({
        id: `history-evidence-${index}`,
        source: 'history',
        category: undefined,
        producer: entry.skill,
        title: entry.artifactTitle || entry.skill,
        contentPreview: entry.output.slice(0, 240),
        createdAt: message.timestamp || new Date().toISOString(),
        payload: entry.artifactData,
      });
    }
  }

  return nodes;
}

export interface AgentGraphBuilder {
  rootTaskId: string;
  addSpecialistTask(args: {
    specialist: SpecialistName;
    source: 'supervisor';
    goal: string;
    category?: string;
    outputPreview?: string | null;
    artifacts?: Artifact[];
  }): void;
  addFinalReply(text: string | null): void;
  build(): AgentTaskGraph;
}

export function createAgentGraphBuilder(args: {
  requestId: string;
  containerInput: ContainerInput;
}): AgentGraphBuilder {
  const now = new Date().toISOString();
  const rootTaskId = `task-root-${args.requestId}`;
  const tasks: AgentTaskNode[] = [
    {
      id: rootTaskId,
      kind: 'root',
      status: 'completed',
      source: 'supervisor',
      goal: args.containerInput.userMessage,
      startedAt: now,
    },
  ];
  const evidence = collectHistoryEvidence(args.containerInput.history);
  const edges: AgentGraphEdge[] = evidence.map((node) =>
    makeEdge(rootTaskId, node.id, 'uses'),
  );
  const specialistSequence: string[] = [];
  let taskCounter = 0;

  return {
    rootTaskId,
    addSpecialistTask(input) {
      taskCounter += 1;
      specialistSequence.push(input.specialist);
      const taskId = `task-${taskCounter}-${input.specialist}`;
      tasks.push({
        id: taskId,
        kind: 'specialist',
        status: 'completed',
        source: input.source,
        specialist: input.specialist,
        goal: input.goal,
        category: input.category,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        outputPreview: input.outputPreview?.slice(0, 240) ?? undefined,
      });
      edges.push(makeEdge(rootTaskId, taskId, 'delegates'));

      for (const artifact of input.artifacts ?? []) {
        const node: AgentEvidenceNode = {
          id: `artifact-${artifact.id}`,
          source: 'artifact',
          category: artifact.category,
          producer: artifact.producer,
          title: artifact.title,
          contentPreview: artifact.rawOutput.slice(0, 240),
          createdAt: artifact.createdAt,
          artifactId: artifact.id,
          payload: artifact.payload,
        };
        evidence.push(node);
        edges.push(makeEdge(taskId, node.id, 'produces'));
      }
    },
    addFinalReply(text) {
      if (!text) return;
      const node: AgentEvidenceNode = {
        id: `final-reply-${args.requestId}`,
        source: 'final_reply',
        title: '最终回复',
        contentPreview: text.slice(0, 240),
        createdAt: new Date().toISOString(),
        payload: { text },
      };
      evidence.push(node);
      edges.push(makeEdge(rootTaskId, node.id, 'responds_with'));
      tasks[0].completedAt = node.createdAt;
      tasks[0].outputPreview = text.slice(0, 240);
    },
    build() {
      const inferredCategory = tasks
        .find((t) => t.kind === 'specialist' && t.category)
        ?.category;
      const summary: AgentGraphSummary = {
        category: inferredCategory,
        specialistSequence,
        taskCount: tasks.length,
        evidenceCount: evidence.length,
        finalTextPreview: tasks[0].outputPreview,
      };

      return {
        version: 1,
        requestId: args.requestId,
        accountId: args.containerInput.accountId,
        sessionId: args.containerInput.sessionId,
        rootTaskId,
        tasks,
        evidence,
        edges,
        summary,
      };
    },
  };
}
