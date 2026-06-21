import { describe, expect, it } from 'vitest';

import type {
  WorkflowAiNodeDto,
  WorkflowEdgeDto,
  WorkflowGraphDto,
  WorkflowPaipanNodeDto,
} from '@fateclaw/contracts/workflow';

import type {
  WorkflowRunNodeRow,
  WorkflowRunRow,
} from '../../../src/infrastructure/repositories/workflow-run-repository.js';
import {
  createWorkflowRunOrchestrator,
  type OrchestratorRunSnapshot,
  type WorkflowRunExecutor,
  type WorkflowRunOrchestrator,
  type WorkflowRunStore,
} from '../../../src/modules/workflow/run-orchestrator.js';
import {
  computeReadyNodes,
  deriveRunStatus,
  descendantsOf,
} from '../../../src/modules/workflow/workflow-run-topology.js';

const USER = 'u1';
const TS = '2026-06-21T00:00:00Z';

function aiNode(id: string, pauseAfter = false): WorkflowAiNodeDto {
  return {
    id,
    type: 'ai',
    title: id,
    pauseAfter,
    position: { x: 0, y: 0 },
    promptTemplate: '',
    skillIds: [],
    skillSnapshotIds: [],
    modelPolicy: { mode: 'system-default' },
  };
}

function paipanNode(id: string, pauseAfter = false): WorkflowPaipanNodeDto {
  return {
    id,
    type: 'paipan',
    title: id,
    pauseAfter,
    position: { x: 0, y: 0 },
    skill: 'bazi-paipan',
    inputDefaults: {},
  };
}

function edge(source: string, target: string): WorkflowEdgeDto {
  return { id: `${source}->${target}`, source, target };
}

/** 内存 store(测试用):runs / run_nodes 全在内存,loadRun 回灌固定定义图。 */
function makeMemStore(graph: WorkflowGraphDto): WorkflowRunStore {
  const runs = new Map<string, WorkflowRunRow>();
  const nodeMap = new Map<string, Map<string, WorkflowRunNodeRow>>();
  return {
    async createRun(run, ns) {
      runs.set(run.id, {
        id: run.id,
        user_id: run.userId,
        workflow_definition_id: run.workflowDefinitionId,
        chat_session_id: run.chatSessionId,
        client_id: run.clientId ?? null,
        title: run.title,
        status: 'running',
        input: run.input ?? {},
        error: null,
        created_at: TS,
        updated_at: TS,
      });
      const m = new Map<string, WorkflowRunNodeRow>();
      for (const n of ns) {
        m.set(n.nodeId, {
          run_id: run.id,
          node_id: n.nodeId,
          node_type: n.nodeType,
          title: n.title,
          pause_after: n.pauseAfter,
          status: 'pending',
          output_message_id: null,
          output_account_id: null,
          error: null,
          attempt: 0,
          created_at: TS,
          updated_at: TS,
        });
      }
      nodeMap.set(run.id, m);
    },
    async loadRun(runId, userId) {
      const run = runs.get(runId);
      if (!run || run.user_id !== userId) return null;
      return {
        run: { ...run },
        nodes: [...(nodeMap.get(runId)?.values() ?? [])].map((r) => ({ ...r })),
        graph,
      };
    },
    async updateNode(runId, nodeId, patch) {
      const row = nodeMap.get(runId)?.get(nodeId);
      if (!row) return;
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.outputMessageId !== undefined)
        row.output_message_id = patch.outputMessageId;
      if (patch.outputAccountId !== undefined)
        row.output_account_id = patch.outputAccountId;
      if (patch.error !== undefined) row.error = patch.error;
      if (patch.bumpAttempt) row.attempt += 1;
    },
    async updateRunStatus(runId, status, error) {
      const run = runs.get(runId);
      if (!run) return;
      run.status = status;
      run.error = error ?? null;
    },
  };
}

/** AI 节点自动完成的 fake executor;failIds 内的节点发起即抛错。 */
function autoExecutor(
  getOrch: () => WorkflowRunOrchestrator,
  failIds: Set<string> = new Set(),
): WorkflowRunExecutor {
  return {
    async startAiNode(node, ctx) {
      if (failIds.has(node.id)) {
        throw new Error(`boom ${node.id}`);
      }
      await getOrch().markNodeCompleted(ctx.runId, USER, node.id, {
        messageId: `msg-${node.id}`,
        accountId: 'web:u1',
      });
    },
  };
}

async function startWith(
  graph: WorkflowGraphDto,
  failIds?: Set<string>,
): Promise<{ orch: WorkflowRunOrchestrator; snap: OrchestratorRunSnapshot }> {
  const store = makeMemStore(graph);
  let orch!: WorkflowRunOrchestrator;
  orch = createWorkflowRunOrchestrator({
    store,
    executor: autoExecutor(() => orch, failIds),
  });
  const snap = await orch.startRun({
    runId: 'run-1',
    userId: USER,
    definitionId: 'def-1',
    graph,
    chatSessionId: 'session-1',
    title: 't',
    input: {},
  });
  return { orch, snap };
}

function statusOf(snap: OrchestratorRunSnapshot, id: string) {
  return snap.nodes.find((n) => n.nodeId === id)?.status;
}

describe('run-orchestrator 拓扑推进', () => {
  it('线性 A→B:全程自动跑到 done', async () => {
    const graph: WorkflowGraphDto = {
      nodes: [aiNode('A'), aiNode('B')],
      edges: [edge('A', 'B')],
    };
    const { snap } = await startWith(graph);
    expect(snap.status).toBe('done');
    expect(statusOf(snap, 'A')).toBe('done');
    expect(statusOf(snap, 'B')).toBe('done');
    expect(snap.nodes.find((n) => n.nodeId === 'B')?.outputMessageId).toBe(
      'msg-B',
    );
  });

  it('分叉 A→B / A→C:A 完成后 B、C 都跑', async () => {
    const graph: WorkflowGraphDto = {
      nodes: [aiNode('A'), aiNode('B'), aiNode('C')],
      edges: [edge('A', 'B'), edge('A', 'C')],
    };
    const { snap } = await startWith(graph);
    expect(snap.status).toBe('done');
    expect(statusOf(snap, 'B')).toBe('done');
    expect(statusOf(snap, 'C')).toBe('done');
  });

  it('汇总(菱形)A→B,A→C,B→D,C→D:D 等 B、C 都完成才跑', async () => {
    const graph: WorkflowGraphDto = {
      nodes: [aiNode('A'), aiNode('B'), aiNode('C'), aiNode('D')],
      edges: [edge('A', 'B'), edge('A', 'C'), edge('B', 'D'), edge('C', 'D')],
    };
    const { snap } = await startWith(graph);
    expect(snap.status).toBe('done');
    expect(statusOf(snap, 'D')).toBe('done');
  });

  it('排盘节点:就绪后置 awaiting_paipan 等卦师提交,提交后继续', async () => {
    const graph: WorkflowGraphDto = {
      nodes: [paipanNode('P'), aiNode('A')],
      edges: [edge('P', 'A')],
    };
    const { orch, snap } = await startWith(graph);
    // 排盘节点不自动跑,停在 awaiting_paipan;下游 A 仍 pending。
    expect(statusOf(snap, 'P')).toBe('awaiting_paipan');
    expect(statusOf(snap, 'A')).toBe('pending');
    expect(snap.status).toBe('running');

    // 卦师起盘提交 → P 完成 → A 自动跑 → done。
    const after = await orch.markNodeCompleted('run-1', USER, 'P', {
      messageId: 'board-P',
      accountId: 'web:u1',
    });
    expect(after.status).toBe('done');
    expect(statusOf(after, 'P')).toBe('done');
    expect(statusOf(after, 'A')).toBe('done');
  });

  it('pauseAfter:命中暂停节点后整体 paused,resume 续跑', async () => {
    const graph: WorkflowGraphDto = {
      nodes: [aiNode('A', true), aiNode('B')],
      edges: [edge('A', 'B')],
    };
    const { orch, snap } = await startWith(graph);
    expect(snap.status).toBe('paused');
    expect(statusOf(snap, 'A')).toBe('done');
    expect(statusOf(snap, 'B')).toBe('pending');

    const resumed = await orch.resume('run-1', USER);
    expect(resumed.status).toBe('done');
    expect(statusOf(resumed, 'B')).toBe('done');
  });

  it('从节点级联重跑:A→B→C 全 done 后 rerunFrom(B) 只重置 B、C,A 不动', async () => {
    const graph: WorkflowGraphDto = {
      nodes: [aiNode('A'), aiNode('B'), aiNode('C')],
      edges: [edge('A', 'B'), edge('B', 'C')],
    };
    const { orch, snap } = await startWith(graph);
    expect(snap.status).toBe('done');
    const aMsgBefore = snap.nodes.find((n) => n.nodeId === 'A')?.outputMessageId;

    const reran = await orch.rerunFromNode('run-1', USER, 'B');
    expect(reran.status).toBe('done');
    // A 未被触碰(产出消息 id 不变),B、C 重新跑过(仍 done)。
    expect(reran.nodes.find((n) => n.nodeId === 'A')?.outputMessageId).toBe(
      aMsgBefore,
    );
    expect(statusOf(reran, 'B')).toBe('done');
    expect(statusOf(reran, 'C')).toBe('done');
  });

  it('跳过节点:skip(A) 后其下游照常放行', async () => {
    const graph: WorkflowGraphDto = {
      nodes: [aiNode('A'), aiNode('B')],
      edges: [edge('A', 'B')],
    };
    // A 设为会失败,改用 skip 绕过。
    const store = makeMemStore(graph);
    let orch!: WorkflowRunOrchestrator;
    orch = createWorkflowRunOrchestrator({
      store,
      executor: autoExecutor(() => orch, new Set(['A'])),
    });
    const snap = await orch.startRun({
      runId: 'run-1',
      userId: USER,
      definitionId: 'def-1',
      graph,
      chatSessionId: 'session-1',
      title: 't',
      input: {},
    });
    expect(statusOf(snap, 'A')).toBe('error');

    const skipped = await orch.skipNode('run-1', USER, 'A');
    expect(statusOf(skipped, 'A')).toBe('skipped');
    expect(statusOf(skipped, 'B')).toBe('done');
    expect(skipped.status).toBe('done');
  });

  it('一个失败不连坐:B 失败,兄弟 C 仍跑完;D 因 B 卡住,整体 error', async () => {
    const graph: WorkflowGraphDto = {
      nodes: [aiNode('A'), aiNode('B'), aiNode('C'), aiNode('D')],
      edges: [edge('A', 'B'), edge('A', 'C'), edge('B', 'D'), edge('C', 'D')],
    };
    const { snap } = await startWith(graph, new Set(['B']));
    expect(statusOf(snap, 'B')).toBe('error');
    expect(statusOf(snap, 'C')).toBe('done'); // 兄弟分支不连坐
    expect(statusOf(snap, 'D')).toBe('pending'); // 被 B 卡住
    expect(snap.status).toBe('error');
  });
});

describe('workflow-run-topology 纯函数', () => {
  const diamond: WorkflowGraphDto = {
    nodes: [aiNode('A'), aiNode('B'), aiNode('C'), aiNode('D')],
    edges: [edge('A', 'B'), edge('A', 'C'), edge('B', 'D'), edge('C', 'D')],
  };

  it('computeReadyNodes:起点就绪;上游未满足则不就绪', () => {
    expect(computeReadyNodes(diamond, {})).toEqual(['A']);
    expect(
      computeReadyNodes(diamond, { A: 'done' }).sort(),
    ).toEqual(['B', 'C']);
    // A、B done 时 C 仍就绪(其上游 A 已满足);D 还差 C 故未就绪。
    expect(computeReadyNodes(diamond, { A: 'done', B: 'done' })).toEqual(['C']);
    expect(
      computeReadyNodes(diamond, { A: 'done', B: 'done', C: 'skipped' }),
    ).toEqual(['D']); // skipped 也算满足
  });

  it('descendantsOf:收集全部下游后代', () => {
    expect(descendantsOf(diamond, 'A').sort()).toEqual(['B', 'C', 'D']);
    expect(descendantsOf(diamond, 'B')).toEqual(['D']);
    expect(descendantsOf(diamond, 'D')).toEqual([]);
  });

  it('deriveRunStatus:running / done / error 三态', () => {
    expect(deriveRunStatus(diamond, {})).toBe('running');
    expect(
      deriveRunStatus(diamond, {
        A: 'done',
        B: 'done',
        C: 'done',
        D: 'done',
      }),
    ).toBe('done');
    // B 失败致 D 永远卡住、无在途/就绪 → error
    expect(
      deriveRunStatus(diamond, { A: 'done', B: 'error', C: 'done' }),
    ).toBe('error');
  });
});
