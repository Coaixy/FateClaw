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

function aiNode(id: string): WorkflowAiNodeDto {
  return {
    id,
    type: 'ai',
    title: id,
    position: { x: 0, y: 0 },
    promptTemplate: '',
    skillIds: [],
    skillSnapshotIds: [],
    modelPolicy: { mode: 'system-default' },
  };
}

function paipanNode(id: string): WorkflowPaipanNodeDto {
  return {
    id,
    type: 'paipan',
    title: id,
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
  it('线性 A→B:跑完停在 paused 待确认,resume(点完成)后 done', async () => {
    const graph: WorkflowGraphDto = {
      nodes: [aiNode('A'), aiNode('B')],
      edges: [edge('A', 'B')],
    };
    const { orch, snap } = await startWith(graph);
    // 方案A:全部节点完成 → 整体 paused 等卦师润色/确认(不直接 done)。
    expect(snap.status).toBe('paused');
    expect(statusOf(snap, 'A')).toBe('done');
    expect(statusOf(snap, 'B')).toBe('done');
    expect(snap.nodes.find((n) => n.nodeId === 'B')?.outputMessageId).toBe(
      'msg-B',
    );
    // 卦师点「完成」→ done。
    const resumed = await orch.resume('run-1', USER);
    expect(resumed.status).toBe('done');
  });

  it('分叉 A→B / A→C:A 完成后 B、C 都跑,跑完 paused', async () => {
    const graph: WorkflowGraphDto = {
      nodes: [aiNode('A'), aiNode('B'), aiNode('C')],
      edges: [edge('A', 'B'), edge('A', 'C')],
    };
    const { snap } = await startWith(graph);
    expect(snap.status).toBe('paused');
    expect(statusOf(snap, 'B')).toBe('done');
    expect(statusOf(snap, 'C')).toBe('done');
  });

  it('汇总(菱形)A→B,A→C,B→D,C→D:D 等 B、C 都完成才跑,跑完 paused', async () => {
    const graph: WorkflowGraphDto = {
      nodes: [aiNode('A'), aiNode('B'), aiNode('C'), aiNode('D')],
      edges: [edge('A', 'B'), edge('A', 'C'), edge('B', 'D'), edge('C', 'D')],
    };
    const { snap } = await startWith(graph);
    expect(snap.status).toBe('paused');
    expect(statusOf(snap, 'D')).toBe('done');
  });

  it('排盘节点:就绪后置 awaiting_paipan 等卦师提交,提交后跑完 paused', async () => {
    const graph: WorkflowGraphDto = {
      nodes: [paipanNode('P'), aiNode('A')],
      edges: [edge('P', 'A')],
    };
    const { orch, snap } = await startWith(graph);
    // 排盘节点不自动跑,停在 awaiting_paipan;下游 A 仍 pending。
    expect(statusOf(snap, 'P')).toBe('awaiting_paipan');
    expect(statusOf(snap, 'A')).toBe('pending');
    expect(snap.status).toBe('running');

    // 卦师起盘提交 → P 完成 → A 自动跑 → 全部完成 → paused。
    const after = await orch.markNodeCompleted('run-1', USER, 'P', {
      messageId: 'board-P',
      accountId: 'web:u1',
    });
    expect(after.status).toBe('paused');
    expect(statusOf(after, 'P')).toBe('done');
    expect(statusOf(after, 'A')).toBe('done');
  });

  it('方案A 多叶子:B、C 两个终端成品跑完只整体 paused 一次,resume 后 done', async () => {
    // A 分叉到 B、C 两个叶节点(各是一份成品)。验证不会"每个成品停一次"。
    const graph: WorkflowGraphDto = {
      nodes: [aiNode('A'), aiNode('B'), aiNode('C')],
      edges: [edge('A', 'B'), edge('A', 'C')],
    };
    const { orch, snap } = await startWith(graph);
    // 两个叶子都完成,但运行只 paused 一次(整体待确认),不会卡住任一分支。
    expect(snap.status).toBe('paused');
    expect(statusOf(snap, 'A')).toBe('done');
    expect(statusOf(snap, 'B')).toBe('done');
    expect(statusOf(snap, 'C')).toBe('done');

    // 卦师润色完两份成品后点「完成」→ done。
    const resumed = await orch.resume('run-1', USER);
    expect(resumed.status).toBe('done');
    expect(statusOf(resumed, 'B')).toBe('done');
    expect(statusOf(resumed, 'C')).toBe('done');
  });

  it('从节点级联重跑:A→B→C 跑完 paused 后 rerunFrom(B) 只重置 B、C,A 不动,重跑完仍 paused', async () => {
    const graph: WorkflowGraphDto = {
      nodes: [aiNode('A'), aiNode('B'), aiNode('C')],
      edges: [edge('A', 'B'), edge('B', 'C')],
    };
    const { orch, snap } = await startWith(graph);
    expect(snap.status).toBe('paused');
    const aMsgBefore = snap.nodes.find((n) => n.nodeId === 'A')?.outputMessageId;

    const reran = await orch.rerunFromNode('run-1', USER, 'B');
    expect(reran.status).toBe('paused');
    // A 未被触碰(产出消息 id 不变),B、C 重新跑过(仍 done)。
    expect(reran.nodes.find((n) => n.nodeId === 'A')?.outputMessageId).toBe(
      aMsgBefore,
    );
    expect(statusOf(reran, 'B')).toBe('done');
    expect(statusOf(reran, 'C')).toBe('done');
  });

  it('跳过节点:skip(A) 后其下游照常放行,跑完 paused', async () => {
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
    expect(skipped.status).toBe('paused');
  });

  it('串行发起:就绪的并行 AI 节点一次只发起一个(防会话锁 409 误判失败)', async () => {
    const graph: WorkflowGraphDto = {
      nodes: [aiNode('A'), aiNode('B'), aiNode('C')],
      edges: [edge('A', 'B'), edge('A', 'C')],
    };
    const store = makeMemStore(graph);
    const started: string[] = [];
    // 只记录发起、不自动完成,以观察"同时发起几个"。
    const executor: WorkflowRunExecutor = {
      async startAiNode(node) {
        started.push(node.id);
      },
    };
    const orch = createWorkflowRunOrchestrator({ store, executor });

    await orch.startRun({
      runId: 'run-1',
      userId: USER,
      definitionId: 'def-1',
      graph,
      chatSessionId: 'session-1',
      title: 't',
      input: {},
    });
    // 起点只发起 A。
    expect(started).toEqual(['A']);

    // A 完成 → B、C 都就绪,但只发起其中一个(不并发,避免会话锁 409)。
    await orch.markNodeCompleted('run-1', USER, 'A', {
      messageId: 'm-A',
      accountId: 'web:u1',
    });
    expect(started.length).toBe(2);
    const second = started[1];
    expect(['B', 'C']).toContain(second);

    // 第二个完成 → 才发起最后一个。
    await orch.markNodeCompleted('run-1', USER, second, {
      messageId: `m-${second}`,
      accountId: 'web:u1',
    });
    expect(started.length).toBe(3);
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
