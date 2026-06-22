/**
 * 卦师工作流后端拓扑编排状态机。
 *
 * 把"运行推进"从前端(~10 个 useRef + 轮询)下沉到后端:按拓扑序推进就绪节点、处理暂停/续跑/
 * 级联重跑/跳过/手填,产出仍落 chat 会话(messages)。store(持久化)与 executor(节点执行)由
 * 依赖注入,故本状态机可纯逻辑单测;真实 store/executor 在 P2 接入。
 *
 * 推进模型(P1 串行;真并行解锁在 P2 拆会话锁后):
 *   advance 先把"本轮就绪"节点一次性持久化为在途(AI→running、排盘→awaiting_paipan),
 *   再逐个发起 AI 节点 —— 先持久化在途再发起,保证完成事件重入 advance 时不会重复发起。
 *   AI 完成由 outbox 经 markNodeCompleted 驱动;排盘完成由前端起盘提交经 markNodeCompleted 驱动。
 *   全部节点完成 → 运行整体 paused(等卦师润色/确认全部成品),resume(卦师点「完成」)后落 done。
 */
import type {
  WorkflowAiNodeDto,
  WorkflowGraphDto,
  WorkflowNodeDto,
  WorkflowRunNodeStatus,
  WorkflowRunStatus,
} from '@fateclaw/contracts/workflow';

import type {
  NewWorkflowRun,
  NewWorkflowRunNode,
  WorkflowRunNodePatch,
  WorkflowRunNodeRow,
  WorkflowRunRow,
} from '../../infrastructure/repositories/workflow-run-repository.js';
import {
  computeReadyNodes,
  deriveRunStatus,
  descendantsOf,
  type NodeStatusMap,
} from './workflow-run-topology.js';

/** 已装载的一次运行(run 行 + 节点行 + 定义图)。 */
export interface LoadedWorkflowRun {
  run: WorkflowRunRow;
  nodes: WorkflowRunNodeRow[];
  graph: WorkflowGraphDto;
}

/** 编排器依赖的持久化接口(生产=仓储;测试=内存实现)。 */
export interface WorkflowRunStore {
  createRun(run: NewWorkflowRun, nodes: NewWorkflowRunNode[]): Promise<void>;
  /** 读运行 + 节点 + 定义图(图来自 workflow_definitions,运行不另存快照)。 */
  loadRun(runId: string, userId: string): Promise<LoadedWorkflowRun | null>;
  updateNode(
    runId: string,
    nodeId: string,
    patch: WorkflowRunNodePatch,
  ): Promise<void>;
  updateRunStatus(
    runId: string,
    status: WorkflowRunStatus,
    error?: string | null,
  ): Promise<void>;
}

/** 节点执行上下文(executor 据此渲染 prompt / 注入入边盘面 / 发起一轮 AI)。 */
export interface NodeExecContext {
  runId: string;
  userId: string;
  sessionId: string;
  clientId?: string;
  input: Record<string, string>;
  graph: WorkflowGraphDto;
}

/** 节点执行接口(生产=接 LLM 原语 / 排盘 runtime;测试=fake)。 */
export interface WorkflowRunExecutor {
  /**
   * 发起 AI 节点:异步回复经 outbox 落库,受理即返回(节点保持 running),完成由 markNodeCompleted 驱动。
   * 同步即失败(如无可用模型)应抛错,由编排器置该节点 error。
   */
  startAiNode(node: WorkflowAiNodeDto, ctx: NodeExecContext): Promise<void>;
}

/** 运行启动入参。 */
export interface StartRunArgs {
  runId: string;
  userId: string;
  definitionId: string;
  graph: WorkflowGraphDto;
  chatSessionId: string;
  title: string;
  input: Record<string, string>;
  clientId?: string;
}

/** 编排器对外快照里的单节点。 */
export interface OrchestratorRunNode {
  nodeId: string;
  type: WorkflowNodeDto['type'];
  title: string;
  status: WorkflowRunNodeStatus;
  outputMessageId: string | null;
  outputAccountId: string | null;
  error: string | null;
}

/** 编排器对外的运行快照(路由层再据此 + messages 正文组装 DTO)。 */
export interface OrchestratorRunSnapshot {
  runId: string;
  sessionId: string;
  definitionId: string;
  clientId: string | null;
  title: string;
  status: WorkflowRunStatus;
  input: Record<string, string>;
  startedAt: string;
  graph: WorkflowGraphDto;
  nodes: OrchestratorRunNode[];
}

/** 产出消息复合外键(两列同时给,避免脏指针)。 */
export interface NodeOutputRef {
  messageId: string;
  accountId: string;
}

function statusMapOf(nodes: WorkflowRunNodeRow[]): NodeStatusMap {
  const map: NodeStatusMap = {};
  for (const node of nodes) {
    map[node.node_id] = node.status;
  }
  return map;
}

function toSnapshot(loaded: LoadedWorkflowRun): OrchestratorRunSnapshot {
  const { run, nodes, graph } = loaded;
  const rowByNode = new Map(nodes.map((node) => [node.node_id, node]));
  return {
    runId: run.id,
    sessionId: run.chat_session_id,
    definitionId: run.workflow_definition_id,
    clientId: run.client_id,
    title: run.title,
    status: run.status,
    input: run.input ?? {},
    startedAt: run.created_at,
    graph,
    nodes: graph.nodes.map((node) => {
      const row = rowByNode.get(node.id);
      return {
        nodeId: node.id,
        type: node.type,
        title: node.title,
        status: row?.status ?? 'pending',
        outputMessageId: row?.output_message_id ?? null,
        outputAccountId: row?.output_account_id ?? null,
        error: row?.error ?? null,
      };
    }),
  };
}

/**
 * 创建编排器实例。
 *
 * @param deps store 持久化 + executor 节点执行(均依赖注入)。
 */
export function createWorkflowRunOrchestrator(deps: {
  store: WorkflowRunStore;
  executor: WorkflowRunExecutor;
}) {
  const { store, executor } = deps;

  /** 装载运行;不存在/非本人抛错。 */
  async function load(runId: string, userId: string): Promise<LoadedWorkflowRun> {
    const loaded = await store.loadRun(runId, userId);
    if (!loaded) {
      throw new Error('工作流运行不存在或无权访问');
    }
    return loaded;
  }

  /**
   * 推进运行:把本轮就绪节点持久化为在途并发起 AI 节点。
   *
   * @remarks 仅 status='running' 时推进(paused/done/error/canceled 不自动推进)。
   */
  async function advance(
    runId: string,
    userId: string,
  ): Promise<OrchestratorRunSnapshot> {
    const loaded = await load(runId, userId);
    if (loaded.run.status !== 'running') {
      return toSnapshot(loaded);
    }

    const statusByNode = statusMapOf(loaded.nodes);
    const derived = deriveRunStatus(loaded.graph, statusByNode);
    if (derived !== 'running') {
      // 方案A:全部节点完成不直接收束为 done,先停在 paused 等卦师润色/确认全部成品;
      // resume(卦师点「完成」)才落 done。error 仍直接置 error。
      const settled = derived === 'done' ? 'paused' : derived;
      await store.updateRunStatus(runId, settled);
      return toSnapshot({
        ...loaded,
        run: { ...loaded.run, status: settled },
      });
    }

    const ready = computeReadyNodes(loaded.graph, statusByNode);
    const nodeById = new Map(loaded.graph.nodes.map((node) => [node.id, node]));

    // 排盘节点:就绪即置 awaiting_paipan(不占会话锁,可并存等卦师逐个起盘)。
    for (const nodeId of ready) {
      const node = nodeById.get(nodeId);
      if (node?.type === 'paipan') {
        await store.updateNode(runId, nodeId, { status: 'awaiting_paipan' });
      }
    }

    // AI 节点:同一运行会话有处理锁,P2.5 拆锁前必须串行 —— 已有 AI 在跑则本轮不再发起
    // (等其完成回灌后下次 advance 再推进);否则只发起一个就绪 AI,其余就绪 AI 留 pending。
    // 并发发起会撞「上一条仍在处理」409 把兄弟节点误判为失败,故这里一次只发一个。
    const aiAlreadyRunning = loaded.nodes.some(
      (node) => node.status === 'running',
    );
    if (!aiAlreadyRunning) {
      const nextAi = ready
        .map((nodeId) => nodeById.get(nodeId))
        .find((node): node is WorkflowAiNodeDto => node?.type === 'ai');
      if (nextAi) {
        // 先持久化为 running 再发起:完成事件重入 advance 时它已非 pending,不会被重复发起。
        await store.updateNode(runId, nextAi.id, {
          status: 'running',
          bumpAttempt: true,
          error: null,
        });
        const ctx: NodeExecContext = {
          runId,
          userId,
          sessionId: loaded.run.chat_session_id,
          clientId: loaded.run.client_id ?? undefined,
          input: loaded.run.input ?? {},
          graph: loaded.graph,
        };
        try {
          await executor.startAiNode(nextAi, ctx);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await markNodeFailed(runId, userId, nextAi.id, message);
        }
      }
    }

    const after = await load(runId, userId);
    return toSnapshot(after);
  }

  /**
   * 标记某节点完成(产出落库后调用:AI 由 outbox、排盘由前端起盘提交),随即推进。
   *
   * @remarks 推进到全部节点完成时,advance 会把运行整体置 paused 等卦师确认(方案A)。
   */
  async function markNodeCompleted(
    runId: string,
    userId: string,
    nodeId: string,
    output: NodeOutputRef,
  ): Promise<OrchestratorRunSnapshot> {
    await load(runId, userId);
    await store.updateNode(runId, nodeId, {
      status: 'done',
      outputMessageId: output.messageId,
      outputAccountId: output.accountId,
      error: null,
    });
    return advance(runId, userId);
  }

  /** 标记某节点失败(执行抛错 / 外部失败回报);兄弟分支仍会在 advance 里继续推进。 */
  async function markNodeFailed(
    runId: string,
    userId: string,
    nodeId: string,
    error: string,
  ): Promise<OrchestratorRunSnapshot> {
    await store.updateNode(runId, nodeId, { status: 'error', error });
    return advance(runId, userId);
  }

  /** 卦师手填某节点产出(失败/空节点恢复):置 manual + 关联消息,然后继续推进。 */
  async function recordManualFill(
    runId: string,
    userId: string,
    nodeId: string,
    output: NodeOutputRef,
  ): Promise<OrchestratorRunSnapshot> {
    await load(runId, userId);
    await store.updateNode(runId, nodeId, {
      status: 'manual',
      outputMessageId: output.messageId,
      outputAccountId: output.accountId,
      error: null,
    });
    // 手填是恢复动作:运行可能已因该节点失败而落 error,先复活为 running 再推进。
    await store.updateRunStatus(runId, 'running');
    return advance(runId, userId);
  }

  /** 卦师跳过某节点(其产出视为已满足,放行下游),然后继续推进。 */
  async function skipNode(
    runId: string,
    userId: string,
    nodeId: string,
  ): Promise<OrchestratorRunSnapshot> {
    await load(runId, userId);
    await store.updateNode(runId, nodeId, { status: 'skipped', error: null });
    // 跳过是推进意图:运行可能已落 error/paused,先复活为 running 再推进。
    await store.updateRunStatus(runId, 'running');
    return advance(runId, userId);
  }

  /**
   * 卦师点「完成」:确认全部成品、收束运行(方案A)。
   *
   * @remarks paused 表示全部节点已完成、等卦师润色/确认;确认即落 done。
   *          防御:若此刻仍有未完成节点(理论上不会,只有全完成才会 paused),回到 running 继续推进。
   */
  async function resume(
    runId: string,
    userId: string,
  ): Promise<OrchestratorRunSnapshot> {
    const loaded = await load(runId, userId);
    if (loaded.run.status !== 'paused') {
      return toSnapshot(loaded);
    }
    const derived = deriveRunStatus(loaded.graph, statusMapOf(loaded.nodes));
    if (derived === 'done') {
      await store.updateRunStatus(runId, 'done');
      return toSnapshot({ ...loaded, run: { ...loaded.run, status: 'done' } });
    }
    await store.updateRunStatus(runId, 'running');
    return advance(runId, userId);
  }

  /**
   * 从某节点级联重跑:把该节点及其全部下游后代重置为 pending(清产出/错误),运行回到 running 再推进。
   */
  async function rerunFromNode(
    runId: string,
    userId: string,
    nodeId: string,
  ): Promise<OrchestratorRunSnapshot> {
    const loaded = await load(runId, userId);
    const toReset = new Set<string>([
      nodeId,
      ...descendantsOf(loaded.graph, nodeId),
    ]);
    for (const id of toReset) {
      await store.updateNode(runId, id, {
        status: 'pending',
        outputMessageId: null,
        outputAccountId: null,
        error: null,
      });
    }
    await store.updateRunStatus(runId, 'running');
    return advance(runId, userId);
  }

  /** 启动一次运行:持久化 run + 全部节点(pending),随即推进起点节点。 */
  async function startRun(args: StartRunArgs): Promise<OrchestratorRunSnapshot> {
    const nodes: NewWorkflowRunNode[] = args.graph.nodes.map((node) => ({
      nodeId: node.id,
      nodeType: node.type,
      title: node.title,
    }));
    await store.createRun(
      {
        id: args.runId,
        userId: args.userId,
        workflowDefinitionId: args.definitionId,
        chatSessionId: args.chatSessionId,
        clientId: args.clientId,
        title: args.title,
        input: args.input,
      },
      nodes,
    );
    return advance(args.runId, args.userId);
  }

  /** 读取运行当前快照(只读,不推进)。 */
  async function getRunSnapshot(
    runId: string,
    userId: string,
  ): Promise<OrchestratorRunSnapshot | null> {
    const loaded = await store.loadRun(runId, userId);
    return loaded ? toSnapshot(loaded) : null;
  }

  return {
    startRun,
    getRunSnapshot,
    advance,
    markNodeCompleted,
    markNodeFailed,
    recordManualFill,
    skipNode,
    resume,
    rerunFromNode,
  };
}

export type WorkflowRunOrchestrator = ReturnType<
  typeof createWorkflowRunOrchestrator
>;
