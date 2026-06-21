/**
 * 卦师工作流运行引擎(后端编排的"活体"装配):把 store + 真实 executor 接进编排状态机,
 * 并提供路由层调用的高层操作(启动/查看/推进/起盘提交/重跑/跳过/手填润色/续跑)。
 *
 * 完成回灌采用轮询式 reconcile:产出由 outbox 异步落库到 messages(带 workflow_node_id 列),
 * 读取运行状态(GET)时把已落库的回复/错误回灌为节点完成/失败再推进 —— 避免 outbox→编排器的
 * 导入环与对 chat 核心的侵入(真并行 + 推送式完成留 P2.5)。产出正文单一真相仍在 messages。
 */
import type {
  WorkflowAiNodeDto,
  WorkflowGraphDto,
  WorkflowRunHistoryResponseDto,
  WorkflowRunStateDto,
} from '@fateclaw/contracts/workflow';

import { listWorkflowRunsByDefinition } from '../../infrastructure/repositories/workflow-run-repository.js';

import {
  createChatSession,
  getSessionMessages,
  getWorkflowDefinition,
  setMessageWorkflowNodeId,
  storeMessage,
  touchChatSession,
  updateOwnedMessageContent,
} from '../../infrastructure/db.js';
import { fail, ok, type ServiceResult } from '../../shared/service-result.js';
import { normalizeOwnedChatSessionTitle } from '../../shared/chat-session-title-policy.js';
import type { NewMessage, SimpleModelPolicy } from '../../shared/types.js';
import { sendOwnedChatSessionMessage } from '../chat/chat-session-service.js';
import {
  getWebChatRuntimeId,
  WEB_CHAT_ASSISTANT_NAME,
} from '../chat/web-chat-runtime.js';
import {
  collectNodeOutputs,
  renderWorkflowPrompt,
  resolveNodeOutputId,
} from '../chat/workflow-run-render.js';
import { resolveSimpleWorkflowLlmRuntime } from '../system/system-config.js';
import {
  createWorkflowRunOrchestrator,
  type NodeExecContext,
  type OrchestratorRunSnapshot,
  type WorkflowRunExecutor,
} from './run-orchestrator.js';
import { workflowRunStore } from './workflow-run-store.js';

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * 某 AI 节点"直接入边排盘节点"的最新盘面消息 id 列表(后端按 graph 算,实现分支盘面隔离)。
 *
 * @remarks 列优先(workflow_node_id 列 + kind='board_result');回退旧 id 约定 `wf-board-<src>-`。
 */
function inboundBoardMessageIds(
  graph: WorkflowGraphDto,
  nodeId: string,
  messages: NewMessage[],
): string[] {
  const paipanIds = new Set(
    graph.nodes.filter((node) => node.type === 'paipan').map((node) => node.id),
  );
  const inboundPaipan = graph.edges
    .filter((edge) => edge.target === nodeId && paipanIds.has(edge.source))
    .map((edge) => edge.source);

  const result: string[] = [];
  for (const source of inboundPaipan) {
    const board = messages
      .filter((message) => {
        const kind = (message.metadata as { kind?: unknown } | null | undefined)
          ?.kind;
        if (kind !== 'board_result') return false;
        return (
          message.workflow_node_id === source ||
          message.id.startsWith(`wf-board-${source}-`)
        );
      })
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))[0];
    if (board) {
      result.push(board.id);
    }
  }
  return result;
}

/** 真实节点执行器:AI 节点 → 渲染 prompt + 注入入边盘面 + 发起一轮 AI(异步回复经 outbox)。 */
const executor: WorkflowRunExecutor = {
  async startAiNode(node: WorkflowAiNodeDto, ctx: NodeExecContext): Promise<void> {
    const runtimeId = getWebChatRuntimeId(ctx.userId);
    const messages = await getSessionMessages(runtimeId, ctx.sessionId);
    const boards = inboundBoardMessageIds(ctx.graph, node.id, messages);
    const rendered =
      renderWorkflowPrompt(node.promptTemplate, {
        input: ctx.input,
        nodeOutputs: collectNodeOutputs(messages),
      }).trim() || node.title;

    const llmRuntime = await resolveSimpleWorkflowLlmRuntime(
      ctx.userId,
      node.modelPolicy as SimpleModelPolicy,
    );

    const userMessageId = `wf-${node.id}-${Date.now()}-${randomSuffix()}`;
    const sendResult = await sendOwnedChatSessionMessage(
      ctx.userId,
      ctx.sessionId,
      {
        content: rendered,
        inputKind: 'normal',
        selectedBoardMessageId: boards[0],
      },
      {
        userMessageId,
        workflowNodeId: node.id,
        llmRuntimeOverride: llmRuntime,
        runtimeUserMessageOverride: rendered,
        authorizedWorkflowSkillIds: node.skillSnapshotIds,
        authorizedSkillBundleIds:
          node.skillSnapshotIds.length > 0 ? undefined : [],
        restrictBoardMessageIds: boards,
        piSessionId: `${userMessageId}__pi`,
      },
    );
    if (!sendResult.ok) {
      throw new Error(sendResult.error);
    }
  },
};

/** 全局编排器单例(生产 store + 真实 executor)。 */
const orchestrator = createWorkflowRunOrchestrator({
  store: workflowRunStore,
  executor,
});

/** 找某节点最新的文本产出消息(reply/manual;排除盘面/错误)。 */
function latestNodeOutputMessage(
  messages: NewMessage[],
  nodeId: string,
): NewMessage | undefined {
  let latest: NewMessage | undefined;
  for (const message of messages) {
    if (resolveNodeOutputId(message) !== nodeId) continue;
    if (!latest || message.timestamp >= latest.timestamp) latest = message;
  }
  return latest;
}

/** 找某节点最新的错误消息(outbox 落 `_error`,带 workflow_node_id 列、kind='error')。 */
function latestNodeErrorMessage(
  messages: NewMessage[],
  nodeId: string,
): NewMessage | undefined {
  let latest: NewMessage | undefined;
  for (const message of messages) {
    if (message.workflow_node_id !== nodeId) continue;
    const kind = (message.metadata as { kind?: unknown } | null | undefined)
      ?.kind;
    if (kind !== 'error') continue;
    if (!latest || message.timestamp >= latest.timestamp) latest = message;
  }
  return latest;
}

/**
 * 把已落库的 AI 回复/错误回灌为节点完成/失败(轮询式完成回灌),再推进。
 *
 * @returns 回灌+推进后的运行快照;运行不存在返回 null。
 */
async function reconcile(
  runId: string,
  userId: string,
): Promise<OrchestratorRunSnapshot | null> {
  const loaded = await workflowRunStore.loadRun(runId, userId);
  if (!loaded) return null;
  const runtimeId = getWebChatRuntimeId(userId);
  const messages = await getSessionMessages(runtimeId, loaded.run.chat_session_id);

  for (const nodeRow of loaded.nodes) {
    if (nodeRow.status !== 'running') continue;
    const reply = latestNodeOutputMessage(messages, nodeRow.node_id);
    if (reply) {
      await orchestrator.markNodeCompleted(runId, userId, nodeRow.node_id, {
        messageId: reply.id,
        accountId: reply.account_id,
      });
      continue;
    }
    const errorMessage = latestNodeErrorMessage(messages, nodeRow.node_id);
    if (errorMessage) {
      await orchestrator.markNodeFailed(
        runId,
        userId,
        nodeRow.node_id,
        errorMessage.content || 'AI 节点执行失败',
      );
    }
  }
  return orchestrator.getRunSnapshot(runId, userId);
}

/** 把编排器快照 + 会话消息正文组装为对外 WorkflowRunStateDto。 */
function toRunStateDto(
  snapshot: OrchestratorRunSnapshot,
  messages: NewMessage[],
): WorkflowRunStateDto {
  const contentById = new Map(messages.map((m) => [m.id, m.content]));
  const toolContextById = new Map(
    messages.map((m) => [m.id, m.tool_context ?? null]),
  );
  return {
    runId: snapshot.runId,
    sessionId: snapshot.sessionId,
    definitionId: snapshot.definitionId,
    title: snapshot.title,
    status: snapshot.status,
    clientId: snapshot.clientId ?? undefined,
    input: snapshot.input,
    startedAt: snapshot.startedAt,
    edges: snapshot.graph.edges,
    nodes: snapshot.nodes.map((node) => ({
      nodeId: node.nodeId,
      type: node.type,
      title: node.title,
      pauseAfter: node.pauseAfter,
      status: node.status,
      // 文本产出:AI/手填取消息正文;排盘节点正文为空(盘面经 outputMessageId 关联 tool_context)。
      output:
        node.type === 'ai' && node.outputMessageId
          ? (contentById.get(node.outputMessageId) ?? '')
          : node.status === 'manual' && node.outputMessageId
            ? (contentById.get(node.outputMessageId) ?? '')
            : '',
      outputMessageId: node.outputMessageId ?? undefined,
      // 盘面/artifact 的 tool_context,供前端 ArtifactRenderer 渲染(排盘节点正文为空但有盘面)。
      toolContext: node.outputMessageId
        ? (toolContextById.get(node.outputMessageId) ?? undefined)
        : undefined,
      error: node.error ?? undefined,
    })),
  };
}

/** 读取会话消息并组装 DTO(快照已含 sessionId)。 */
async function snapshotToDto(
  userId: string,
  snapshot: OrchestratorRunSnapshot,
): Promise<WorkflowRunStateDto> {
  const runtimeId = getWebChatRuntimeId(userId);
  const messages = await getSessionMessages(runtimeId, snapshot.sessionId);
  return toRunStateDto(snapshot, messages);
}

/**
 * 启动一次工作流运行(后端编排版):建会话 + 建 run/run_node + 推进起点节点。
 *
 * @returns 运行状态 DTO;定义不存在 404,停用/无节点/必填缺失 400。
 */
export async function startWorkflowRunV2(
  userId: string,
  definitionId: string,
  options: { clientId?: string; input?: Record<string, string> },
): Promise<ServiceResult<WorkflowRunStateDto>> {
  const definition = await getWorkflowDefinition(definitionId, userId);
  if (!definition) return fail(404, '工作流不存在');
  if (!definition.enabled) return fail(400, '该工作流已停用');
  if (definition.graph.nodes.length === 0) return fail(400, '该工作流还没有节点');

  const input = options.input ?? {};
  for (const item of definition.inputs) {
    if (item.required && !(input[item.key] ?? '').trim()) {
      return fail(400, `请填写「${item.label}」`);
    }
  }

  const runtimeId = getWebChatRuntimeId(userId);
  const sessionId = `session-${Date.now()}-${randomSuffix()}`;
  await createChatSession({
    id: sessionId,
    accountId: runtimeId,
    userId,
    title: normalizeOwnedChatSessionTitle(definition.name),
    clientId: options.clientId,
    origin: 'workflow_run',
    workflowDefinitionId: definition.id,
  });

  const runId = `wfrun-${Date.now()}-${randomSuffix()}`;
  const snapshot = await orchestrator.startRun({
    runId,
    userId,
    definitionId,
    graph: definition.graph,
    chatSessionId: sessionId,
    title: normalizeOwnedChatSessionTitle(definition.name),
    input,
    clientId: options.clientId,
  });
  return ok(await snapshotToDto(userId, snapshot));
}

/** 列出某工作流的后端编排运行历史(创建时间倒序)。 */
export async function listWorkflowRunHistoryV2(
  userId: string,
  definitionId: string,
): Promise<ServiceResult<WorkflowRunHistoryResponseDto>> {
  const rows = await listWorkflowRunsByDefinition(userId, definitionId);
  return ok({
    runs: rows.map((row) => ({
      runId: row.id,
      startedAt: row.created_at,
      status: row.status,
      clientId: row.client_id ?? undefined,
      title: row.title,
    })),
  });
}

/** 读取运行状态(先 reconcile 回灌已落库产出再返回)。 */
export async function getWorkflowRunStateV2(
  userId: string,
  runId: string,
): Promise<ServiceResult<WorkflowRunStateDto>> {
  const snapshot = await reconcile(runId, userId);
  if (!snapshot) return fail(404, '工作流运行不存在或无权访问');
  return ok(await snapshotToDto(userId, snapshot));
}

/**
 * 卦师起盘提交:认领 PaipanSheet 已自落到会话的盘面消息。
 *
 * @remarks 排盘交互复用 PaipanSheet(它自己调 paipanApi.commit 落盘面);这里只把该盘面"认领"给
 *          排盘节点(设 workflow_node_id 列)、标记节点完成并推进 —— 不重复排盘。
 * @param boardMessageId PaipanSheet 提交后返回的盘面消息 id。
 */
export async function commitWorkflowPaipanNodeV2(
  userId: string,
  runId: string,
  nodeId: string,
  boardMessageId: string,
): Promise<ServiceResult<WorkflowRunStateDto>> {
  const loaded = await workflowRunStore.loadRun(runId, userId);
  if (!loaded) return fail(404, '工作流运行不存在或无权访问');
  const node = loaded.graph.nodes.find((item) => item.id === nodeId);
  if (!node || node.type !== 'paipan') return fail(404, '排盘节点不存在');

  const runtimeId = getWebChatRuntimeId(userId);
  // 校验该盘面属于本运行会话且确是盘面消息(防越权/错挂)。
  const messages = await getSessionMessages(runtimeId, loaded.run.chat_session_id);
  const board = messages.find((message) => message.id === boardMessageId);
  if (!board) return fail(404, '盘面不存在');
  const kind = (board.metadata as { kind?: unknown } | null | undefined)?.kind;
  if (kind !== 'board_result') return fail(400, '指定的消息不是盘面');

  // 认领盘面到排盘节点(设列),供编排器关联 + 下游 AI 节点按入边盘面注入。
  await setMessageWorkflowNodeId(
    runtimeId,
    loaded.run.chat_session_id,
    boardMessageId,
    nodeId,
  );
  const snapshot = await orchestrator.markNodeCompleted(runId, userId, nodeId, {
    messageId: boardMessageId,
    accountId: runtimeId,
  });
  return ok(await snapshotToDto(userId, snapshot));
}

/** 从某节点级联重跑下游。 */
export async function rerunWorkflowNodeV2(
  userId: string,
  runId: string,
  nodeId: string,
): Promise<ServiceResult<WorkflowRunStateDto>> {
  const exists = await workflowRunStore.loadRun(runId, userId);
  if (!exists) return fail(404, '工作流运行不存在或无权访问');
  const snapshot = await orchestrator.rerunFromNode(runId, userId, nodeId);
  return ok(await snapshotToDto(userId, snapshot));
}

/** 跳过某节点。 */
export async function skipWorkflowNodeV2(
  userId: string,
  runId: string,
  nodeId: string,
): Promise<ServiceResult<WorkflowRunStateDto>> {
  const exists = await workflowRunStore.loadRun(runId, userId);
  if (!exists) return fail(404, '工作流运行不存在或无权访问');
  const snapshot = await orchestrator.skipNode(runId, userId, nodeId);
  return ok(await snapshotToDto(userId, snapshot));
}

/** 从暂停续跑。 */
export async function resumeWorkflowRunV2(
  userId: string,
  runId: string,
): Promise<ServiceResult<WorkflowRunStateDto>> {
  const exists = await workflowRunStore.loadRun(runId, userId);
  if (!exists) return fail(404, '工作流运行不存在或无权访问');
  await orchestrator.resume(runId, userId);
  const snapshot = await reconcile(runId, userId);
  if (!snapshot) return fail(404, '工作流运行不存在或无权访问');
  return ok(await snapshotToDto(userId, snapshot));
}

/**
 * 保存某节点产出:已有产出 → 润色(改正文);尚无产出 → 手填(补建消息 + 置 manual 并推进)。
 */
export async function saveWorkflowNodeOutputV2(
  userId: string,
  runId: string,
  nodeId: string,
  content: string,
): Promise<ServiceResult<WorkflowRunStateDto>> {
  const loaded = await workflowRunStore.loadRun(runId, userId);
  if (!loaded) return fail(404, '工作流运行不存在或无权访问');
  const nodeRow = loaded.nodes.find((item) => item.node_id === nodeId);
  if (!nodeRow) return fail(404, '工作流节点不存在');

  const runtimeId = getWebChatRuntimeId(userId);

  if (nodeRow.output_message_id) {
    // 润色:改已有产出正文(单一真相在 message,run_node 不动)。
    const updated = await updateOwnedMessageContent(
      runtimeId,
      loaded.run.chat_session_id,
      nodeRow.output_message_id,
      content,
    );
    if (!updated) return fail(404, '产出不存在');
    await touchChatSession(loaded.run.chat_session_id);
    const snapshot = await orchestrator.getRunSnapshot(runId, userId);
    if (!snapshot) return fail(404, '工作流运行不存在或无权访问');
    return ok(await snapshotToDto(userId, snapshot));
  }

  // 手填:补建一条节点产出消息(带 workflow_node_id 列),置 manual 并推进。
  const manualReply: NewMessage = {
    id: `wf-${nodeId}-${Date.now()}-${randomSuffix()}_reply`,
    account_id: runtimeId,
    user_id: userId,
    sender: runtimeId,
    sender_name: WEB_CHAT_ASSISTANT_NAME,
    content,
    timestamp: new Date().toISOString(),
    is_from_me: true,
    is_bot_message: true,
    session_id: loaded.run.chat_session_id,
    workflow_node_id: nodeId,
    metadata: {
      kind: 'final',
      workflow: 'workflow',
      workflow_node_id: nodeId,
      workflow_manual_fill: true,
    },
  };
  await storeMessage(manualReply);
  await touchChatSession(loaded.run.chat_session_id);
  const snapshot = await orchestrator.recordManualFill(runId, userId, nodeId, {
    messageId: manualReply.id,
    accountId: runtimeId,
  });
  return ok(await snapshotToDto(userId, snapshot));
}
