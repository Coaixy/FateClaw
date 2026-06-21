/**
 * 卦师自定义工作流"运行"服务层。
 *
 * 运行不另建状态表:一次运行 = 一个 chat session,每节点产出 = 一条 message。
 * 前端驱动循环:startWorkflowRun 建会话并返回图(节点+边)→ 前端按拓扑序逐个
 * executeWorkflowRunNode → 按 node.pauseAfter 决定自动续跑还是停下来让卦师接管。
 *
 * 节点产出靠消息 id 约定关联:AI 节点的用户消息 id 形如 `wf-<nodeId>-<ts>-<rand>`,其回复 id 即
 * `<userMessageId>_reply`。这样卦师在暂停时润色过回复后,后续节点渲染 {{node.<id>.output}} 读到的
 * 就是润色后的最新内容。nodeId 限定为 [A-Za-z0-9_](见路由校验),故可用 '-' 作分隔符稳定解析。
 *
 * 并行分叉 + 汇总(无条件):一个节点可有多条出边(分叉)、多条入边(汇总);汇总节点的 prompt
 * 引用各上游 {{node.<id>.output}}。同会话有处理锁,故"并行"分支由前端按拓扑序逐个串行执行。
 */
import type {
  WorkflowAiNodeDto,
  WorkflowPaipanNodeDto,
  WorkflowRunListResponseDto,
  WorkflowRunNodeDto,
  WorkflowRunNodeExecuteResponseDto,
  WorkflowRunStartResponseDto,
} from '@fateclaw/contracts/workflow';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import {
  createChatSession,
  getSessionMessages,
  getWorkflowDefinition,
  listWorkflowRunSessions,
  storeMessage,
  touchChatSession,
  updateOwnedMessageContent,
} from '../../infrastructure/db.js';
import { logger } from '../../infrastructure/logger.js';
import { toChatSessionDto } from '../../contracts-adapter/chat-contract.js';
import { fail, ok, type ServiceResult } from '../../shared/service-result.js';
import type { NewMessage, SimpleModelPolicy } from '../../shared/types.js';
import { normalizeOwnedChatSessionTitle } from '../../shared/chat-session-title-policy.js';
import { resolveSimpleWorkflowLlmRuntime } from '../system/system-config.js';
import { sendOwnedChatSessionMessage } from './chat-session-service.js';
import { applyClientProfilePrefill } from './client-profile-service.js';
import { DirectPaipanError, executeDirectPaipan } from './paipan-runtime.js';
import {
  getWebChatRuntimeId,
  WEB_CHAT_ASSISTANT_NAME,
  WEB_CHAT_USER_NAME,
} from './web-chat-runtime.js';
import {
  collectNodeOutputs,
  renderWorkflowPrompt,
} from './workflow-run-render.js';

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function toRunNodeDto(node: {
  id: string;
  type: WorkflowRunNodeDto['type'];
  title: string;
  pauseAfter: boolean;
}): WorkflowRunNodeDto {
  return {
    id: node.id,
    type: node.type,
    title: node.title,
    pauseAfter: node.pauseAfter,
  };
}

function mapDirectPaipanError(error: unknown): ServiceResult<never> {
  if (error instanceof DirectPaipanError) {
    return fail(error.statusCode, error.message);
  }
  logger.error({ err: error }, '工作流排盘节点执行失败');
  return fail(500, '排盘失败,请检查信息后重试');
}

/**
 * 启动一次工作流运行:建会话(可关联客户),把本次输入写入运行起始消息,返回图(节点+边)。
 *
 * @param userId 卦师用户 ID。
 * @param definitionId 工作流定义 ID。
 * @param options 关联客户与本次输入。
 * @returns 新会话 + 节点清单 + 边;定义不存在 404,已停用/无节点 400。
 */
export async function startWorkflowRun(
  userId: string,
  definitionId: string,
  options: { clientId?: string; input?: Record<string, string> },
): Promise<ServiceResult<WorkflowRunStartResponseDto>> {
  const definition = await getWorkflowDefinition(definitionId, userId);
  if (!definition) {
    return fail(404, '工作流不存在');
  }
  if (!definition.enabled) {
    return fail(400, '该工作流已停用');
  }
  if (definition.graph.nodes.length === 0) {
    return fail(400, '该工作流还没有节点');
  }

  // 必填输入项服务端校验(前端 handleStart 也校验,这里兜底防绕过前端直接打接口)。
  for (const input of definition.inputs) {
    if (input.required && !(options.input?.[input.key] ?? '').trim()) {
      return fail(400, `请填写「${input.label}」`);
    }
  }

  const runtimeId = getWebChatRuntimeId(userId);
  const session = await createChatSession({
    id: `session-${Date.now()}-${randomSuffix()}`,
    accountId: runtimeId,
    userId,
    title: normalizeOwnedChatSessionTitle(definition.name),
    clientId: options.clientId,
    // 标记为 workflow 运行会话:不进对话历史侧栏,改在工作流运行历史里按 workflow 聚合展示。
    origin: 'workflow_run',
    workflowDefinitionId: definition.id,
  });

  // 运行起始消息:承载本次输入与关联客户,后续节点执行时据 workflow_definition_id 校验归属并取输入。
  const runStartMessage: NewMessage = {
    id: `wf-run-${Date.now()}-${randomSuffix()}`,
    account_id: runtimeId,
    user_id: userId,
    sender: userId,
    sender_name: WEB_CHAT_USER_NAME,
    content: `开始运行工作流：${definition.name}`,
    timestamp: new Date().toISOString(),
    is_from_me: false,
    is_bot_message: false,
    session_id: session.id,
    metadata: {
      kind: 'workflow_run_start',
      workflow_definition_id: definition.id,
      workflow_input: options.input ?? {},
      workflow_client_id: options.clientId,
    },
  };
  await storeMessage(runStartMessage);
  await touchChatSession(session.id);

  return ok({
    session: toChatSessionDto(session),
    nodes: definition.graph.nodes.map(toRunNodeDto),
    edges: definition.graph.edges,
    inputs: definition.inputs,
  });
}

/**
 * 列出某工作流的运行历史(运行会话摘要,创建时间倒序)。
 *
 * @param userId 卦师用户 ID。
 * @param definitionId 工作流定义 ID。
 * @returns 运行摘要列表;定义不存在或无权限返回 404。
 */
export async function listWorkflowRuns(
  userId: string,
  definitionId: string,
): Promise<ServiceResult<WorkflowRunListResponseDto>> {
  const definition = await getWorkflowDefinition(definitionId, userId);
  if (!definition) {
    return fail(404, '工作流不存在');
  }
  const sessions = await listWorkflowRunSessions(userId, definitionId);
  return ok({
    runs: sessions.map((session) => ({
      sessionId: session.id,
      startedAt: session.created_at,
      clientId: session.client_id ?? undefined,
      title: session.title,
    })),
  });
}

/** 执行排盘节点:跑排盘 runner,把盘面落为带 tool_context 的消息。 */
async function executePaipanNode(args: {
  userId: string;
  runtimeId: string;
  sessionId: string;
  node: WorkflowPaipanNodeDto;
  clientId: string | undefined;
}): Promise<ServiceResult<WorkflowRunNodeExecuteResponseDto>> {
  const paipanInput = await applyClientProfilePrefill(args.userId, args.clientId, {
    ...args.node.inputDefaults,
  });

  let skillContextEntry;
  try {
    const execution = await executeDirectPaipan({
      accountId: args.runtimeId,
      userId: args.userId,
      skillDir: args.node.skill,
      input: paipanInput,
    });
    skillContextEntry = execution.skillContextEntry;
  } catch (error) {
    return mapDirectPaipanError(error);
  }

  const boardMessage: NewMessage = {
    id: `wf-board-${args.node.id}-${Date.now()}-${randomSuffix()}`,
    account_id: args.runtimeId,
    user_id: args.userId,
    sender: args.runtimeId,
    sender_name: WEB_CHAT_ASSISTANT_NAME,
    content: `已生成${skillContextEntry.artifactTitle ?? '盘面'}。`,
    timestamp: new Date().toISOString(),
    is_from_me: true,
    is_bot_message: true,
    session_id: args.sessionId,
    tool_context: JSON.stringify([skillContextEntry]),
    metadata: {
      kind: 'board_result',
      workflow: 'workflow',
      workflow_node_id: args.node.id,
      board_skill: skillContextEntry.skill,
    },
  };
  await storeMessage(boardMessage);
  await touchChatSession(args.sessionId);

  return ok({
    nodeId: args.node.id,
    type: 'paipan',
    pauseAfter: args.node.pauseAfter,
    boardMessageId: boardMessage.id,
  });
}

/** 执行 AI 节点:渲染 prompt(可引用各上游产出),按该节点模型策略与授权快照发起一轮 AI。 */
async function executeAiNode(args: {
  userId: string;
  runtimeId: string;
  sessionId: string;
  node: WorkflowAiNodeDto;
  messages: NewMessage[];
  runInput: Record<string, string>;
  /** 前端按"该 AI 直接入边排盘节点"算出的盘面 id 列表:只注入这些盘、首个为主盘,空=不带盘(隔离)。 */
  boardMessageIds: string[];
}): Promise<ServiceResult<WorkflowRunNodeExecuteResponseDto>> {
  // 收集会话里全部节点产出供模板引用;模板只会引用上游 id,故等价于"按入边收集上游"。
  const rendered =
    renderWorkflowPrompt(args.node.promptTemplate, {
      input: args.runInput,
      nodeOutputs: collectNodeOutputs(args.messages),
    }).trim() || args.node.title;

  let llmRuntime;
  try {
    llmRuntime = await resolveSimpleWorkflowLlmRuntime(
      args.userId,
      args.node.modelPolicy as SimpleModelPolicy,
    );
  } catch (error) {
    logger.error(
      { userId: args.userId, sessionId: args.sessionId, nodeId: args.node.id, err: error },
      '工作流 AI 节点解析模型运行时失败',
    );
    return fail(503, '当前没有可用模型,请稍后再试');
  }

  const userMessageId = `wf-${args.node.id}-${Date.now()}-${randomSuffix()}`;
  const sendResult = await sendOwnedChatSessionMessage(
    args.userId,
    args.sessionId,
    {
      content: rendered,
      inputKind: 'normal',
      // 主盘面 = 入边排盘的第一个;只注入入边盘面(下方 restrictBoardMessageIds),实现分支隔离。
      selectedBoardMessageId: args.boardMessageIds[0],
    },
    {
      userMessageId,
      llmRuntimeOverride: llmRuntime,
      runtimeUserMessageOverride: rendered,
      // 有快照用快照(workflow 授权优先);没绑 skill 则不加载任何用户级 skill,保证工作流确定性。
      authorizedWorkflowSkillIds: args.node.skillSnapshotIds,
      authorizedSkillBundleIds:
        args.node.skillSnapshotIds.length > 0 ? undefined : [],
      // 盘面隔离:只注入该 AI 直接入边排盘的盘面(空数组=不带盘,如纯汇总节点)。
      restrictBoardMessageIds: args.boardMessageIds,
      // Pi 会话隔离:每个 AI 节点用独立 piSessionId(基于本轮唯一 userMessageId),
      // 从而不 reload 兄弟 / 其它节点的 Pi 对话历史;产出仍按 sessionId 落到运行会话供展示与下游引用。
      piSessionId: `${userMessageId}__pi`,
    },
  );
  if (!sendResult.ok) {
    return fail(sendResult.statusCode, sendResult.error);
  }

  return ok({
    nodeId: args.node.id,
    type: 'ai',
    pauseAfter: args.node.pauseAfter,
    assistantMessageId: `${userMessageId}_reply`,
  });
}

/**
 * 执行工作流运行中的某个节点。
 *
 * @param userId 卦师用户 ID。
 * @param definitionId 工作流定义 ID。
 * @param sessionId 运行会话 ID。
 * @param nodeId 节点 ID。
 * @param boardMessageIds AI 节点直接入边排盘的盘面 id 列表(只注入这些盘、首个为主盘);排盘节点忽略。
 * @returns 执行结果(含 pauseAfter 供前端决定是否自动续跑);定义/节点/运行缺失返回 404。
 */
export async function executeWorkflowRunNode(
  userId: string,
  definitionId: string,
  sessionId: string,
  nodeId: string,
  boardMessageIds: string[] = [],
): Promise<ServiceResult<WorkflowRunNodeExecuteResponseDto>> {
  const definition = await getWorkflowDefinition(definitionId, userId);
  if (!definition) {
    return fail(404, '工作流不存在');
  }
  const node = definition.graph.nodes.find((item) => item.id === nodeId);
  if (!node) {
    return fail(404, '工作流节点不存在');
  }

  const runtimeId = getWebChatRuntimeId(userId);
  const messages = await getSessionMessages(runtimeId, sessionId);
  // 用运行起始消息同时做归属校验(account_id 过滤保证只读到本人会话)与本次输入读取。
  const runStart = messages.find((message) => {
    const meta = (message.metadata ?? {}) as Record<string, unknown>;
    return (
      meta.kind === 'workflow_run_start' &&
      meta.workflow_definition_id === definitionId
    );
  });
  if (!runStart) {
    return fail(404, '工作流运行不存在或无权访问');
  }
  const runMeta = (runStart.metadata ?? {}) as Record<string, unknown>;
  const clientId =
    typeof runMeta.workflow_client_id === 'string'
      ? runMeta.workflow_client_id
      : undefined;
  const runInput = (runMeta.workflow_input ?? {}) as Record<string, string>;

  if (node.type === 'paipan') {
    return executePaipanNode({
      userId,
      runtimeId,
      sessionId,
      node,
      clientId,
    });
  }
  return executeAiNode({
    userId,
    runtimeId,
    sessionId,
    node,
    messages,
    runInput,
    boardMessageIds,
  });
}

/** 找到某节点最新的 AI 回复消息(id 约定 `wf-<nodeId>-…_reply`)。 */
function findLatestNodeReply(
  messages: NewMessage[],
  nodeId: string,
): NewMessage | undefined {
  let latest: NewMessage | undefined;
  for (const message of messages) {
    if (
      !message.id.startsWith(`wf-${nodeId}-`) ||
      !message.id.endsWith('_reply')
    ) {
      continue;
    }
    if (!latest || message.timestamp >= latest.timestamp) {
      latest = message;
    }
  }
  return latest;
}

/**
 * 保存某节点的产出正文,供下游节点渲染 {{node.<id>.output}} 时读到。
 *
 * 两种用途:
 * - **润色**:节点已有 AI 回复时,改其正文为润色版。
 * - **手填**:节点执行失败、还没有回复消息时(如 AI 节点发起就 503/超时),卦师手动补写该节点
 *   应有的产出 —— 此时按 id 约定补建一条 `wf-<nodeId>-…_reply` 消息,让下游节点能读到手填内容
 *   (collectNodeOutputs 仅认该 id 约定,不看 metadata.kind)。
 *
 * @param userId 卦师用户 ID。
 * @param definitionId 工作流定义 ID(用于校验运行归属)。
 * @param sessionId 运行会话 ID。
 * @param nodeId 节点 ID。
 * @param content 润色 / 手填的正文。
 * @returns 成功响应;运行缺失返回 404。
 */
export async function saveWorkflowNodeOutput(
  userId: string,
  definitionId: string,
  sessionId: string,
  nodeId: string,
  content: string,
): Promise<ServiceResult<SuccessResponse>> {
  const runtimeId = getWebChatRuntimeId(userId);
  const messages = await getSessionMessages(runtimeId, sessionId);
  const runStart = messages.find((message) => {
    const meta = (message.metadata ?? {}) as Record<string, unknown>;
    return (
      meta.kind === 'workflow_run_start' &&
      meta.workflow_definition_id === definitionId
    );
  });
  if (!runStart) {
    return fail(404, '工作流运行不存在或无权访问');
  }

  const reply = findLatestNodeReply(messages, nodeId);
  if (reply) {
    // 已有产出:润色,改正文。
    const updated = await updateOwnedMessageContent(
      runtimeId,
      sessionId,
      reply.id,
      content,
    );
    if (!updated) {
      return fail(404, '产出不存在');
    }
    await touchChatSession(sessionId);
    return ok({ success: true });
  }

  // 尚无产出(节点执行就失败):手填,补建一条节点回复消息让下游可读。
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
    session_id: sessionId,
    metadata: {
      kind: 'final',
      workflow: 'workflow',
      workflow_node_id: nodeId,
      workflow_manual_fill: true,
    },
  };
  await storeMessage(manualReply);
  await touchChatSession(sessionId);
  return ok({ success: true });
}
