/**
 * 卦师自定义工作流"运行"服务层。
 *
 * 运行不另建状态表:一次运行 = 一个 chat session,每步产出 = 一条 message。
 * 前端驱动循环:startWorkflowRun 建会话并返回步骤清单 → 前端逐步 executeWorkflowRunStep
 * → 按 step.pauseAfter 决定自动续跑还是停下来让卦师接管。
 *
 * 步骤产出靠消息 id 约定关联:AI 步的用户消息 id 形如 `wf-<stepId>-<ts>-<rand>`,其回复 id 即
 * `<userMessageId>_reply`。这样卦师在暂停时润色过回复后,后续步骤渲染 {{step.<id>.output}} 读到的
 * 就是润色后的最新内容。stepId 限定为 [A-Za-z0-9_](见路由校验),故可用 '-' 作分隔符稳定解析。
 */
import type {
  WorkflowAiStepDto,
  WorkflowPaipanStepDto,
  WorkflowRunStartResponseDto,
  WorkflowRunStepDto,
  WorkflowRunStepExecuteResponseDto,
} from '@fateclaw/contracts/workflow';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import {
  createChatSession,
  getSessionMessages,
  getWorkflowDefinition,
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
  collectStepOutputs,
  renderWorkflowPrompt,
} from './workflow-run-render.js';

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** 找到会话里最近一条带盘面(tool_context)的消息 id,供 AI 步把盘面挂进会话上下文。 */
function findLatestBoardMessageId(messages: NewMessage[]): string | undefined {
  let latest: NewMessage | undefined;
  for (const message of messages) {
    if (typeof message.tool_context !== 'string' || !message.tool_context) {
      continue;
    }
    if (!latest || message.timestamp >= latest.timestamp) {
      latest = message;
    }
  }
  return latest?.id;
}

function toRunStepDto(step: {
  id: string;
  type: WorkflowRunStepDto['type'];
  title: string;
  pauseAfter: boolean;
}): WorkflowRunStepDto {
  return {
    id: step.id,
    type: step.type,
    title: step.title,
    pauseAfter: step.pauseAfter,
  };
}

function mapDirectPaipanError(error: unknown): ServiceResult<never> {
  if (error instanceof DirectPaipanError) {
    return fail(error.statusCode, error.message);
  }
  logger.error({ err: error }, '工作流排盘步执行失败');
  return fail(500, '排盘失败,请检查信息后重试');
}

/**
 * 启动一次工作流运行:建会话(可关联客户),把本次输入写入运行起始消息,返回步骤清单。
 *
 * @param userId 卦师用户 ID。
 * @param definitionId 工作流定义 ID。
 * @param options 关联客户与本次输入。
 * @returns 新会话 + 步骤清单;定义不存在 404,已停用/无步骤 400。
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
  if (definition.steps.length === 0) {
    return fail(400, '该工作流还没有步骤');
  }

  const runtimeId = getWebChatRuntimeId(userId);
  const session = await createChatSession({
    id: `session-${Date.now()}-${randomSuffix()}`,
    accountId: runtimeId,
    userId,
    title: normalizeOwnedChatSessionTitle(definition.name),
    clientId: options.clientId,
  });

  // 运行起始消息:承载本次输入与关联客户,后续步骤执行时据 workflow_definition_id 校验归属并取输入。
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
    steps: definition.steps.map(toRunStepDto),
  });
}

/** 执行排盘步:跑排盘 runner,把盘面落为带 tool_context 的消息。 */
async function executePaipanStep(args: {
  userId: string;
  runtimeId: string;
  sessionId: string;
  step: WorkflowPaipanStepDto;
  clientId: string | undefined;
}): Promise<ServiceResult<WorkflowRunStepExecuteResponseDto>> {
  const paipanInput = await applyClientProfilePrefill(args.userId, args.clientId, {
    ...args.step.inputDefaults,
  });

  let skillContextEntry;
  try {
    const execution = await executeDirectPaipan({
      accountId: args.runtimeId,
      userId: args.userId,
      skillDir: args.step.skill,
      input: paipanInput,
    });
    skillContextEntry = execution.skillContextEntry;
  } catch (error) {
    return mapDirectPaipanError(error);
  }

  const boardMessage: NewMessage = {
    id: `wf-board-${args.step.id}-${Date.now()}-${randomSuffix()}`,
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
      workflow_step_id: args.step.id,
      board_skill: skillContextEntry.skill,
    },
  };
  await storeMessage(boardMessage);
  await touchChatSession(args.sessionId);

  return ok({
    stepId: args.step.id,
    type: 'paipan',
    pauseAfter: args.step.pauseAfter,
    boardMessageId: boardMessage.id,
  });
}

/** 执行 AI 步:渲染 prompt,按该步模型策略与授权快照发起一轮 AI。 */
async function executeAiStep(args: {
  userId: string;
  runtimeId: string;
  sessionId: string;
  step: WorkflowAiStepDto;
  messages: NewMessage[];
  runInput: Record<string, string>;
}): Promise<ServiceResult<WorkflowRunStepExecuteResponseDto>> {
  const rendered =
    renderWorkflowPrompt(args.step.promptTemplate, {
      input: args.runInput,
      stepOutputs: collectStepOutputs(args.messages),
    }).trim() || args.step.title;

  let llmRuntime;
  try {
    llmRuntime = await resolveSimpleWorkflowLlmRuntime(
      args.userId,
      args.step.modelPolicy as SimpleModelPolicy,
    );
  } catch (error) {
    logger.error(
      { userId: args.userId, sessionId: args.sessionId, stepId: args.step.id, err: error },
      '工作流 AI 步解析模型运行时失败',
    );
    return fail(503, '当前没有可用模型,请稍后再试');
  }

  const userMessageId = `wf-${args.step.id}-${Date.now()}-${randomSuffix()}`;
  const sendResult = await sendOwnedChatSessionMessage(
    args.userId,
    args.sessionId,
    {
      content: rendered,
      inputKind: 'normal',
      selectedBoardMessageId: findLatestBoardMessageId(args.messages),
    },
    {
      userMessageId,
      llmRuntimeOverride: llmRuntime,
      runtimeUserMessageOverride: rendered,
      // 有快照用快照(workflow 授权优先);没绑 skill 则不加载任何用户级 skill,保证工作流确定性。
      authorizedWorkflowSkillIds: args.step.skillSnapshotIds,
      authorizedSkillBundleIds:
        args.step.skillSnapshotIds.length > 0 ? undefined : [],
    },
  );
  if (!sendResult.ok) {
    return fail(sendResult.statusCode, sendResult.error);
  }

  return ok({
    stepId: args.step.id,
    type: 'ai',
    pauseAfter: args.step.pauseAfter,
    assistantMessageId: `${userMessageId}_reply`,
  });
}

/**
 * 执行工作流运行中的某一步。
 *
 * @param userId 卦师用户 ID。
 * @param definitionId 工作流定义 ID。
 * @param sessionId 运行会话 ID。
 * @param stepId 步骤 ID。
 * @returns 执行结果(含 pauseAfter 供前端决定是否自动续跑);定义/步骤/运行缺失返回 404。
 */
export async function executeWorkflowRunStep(
  userId: string,
  definitionId: string,
  sessionId: string,
  stepId: string,
): Promise<ServiceResult<WorkflowRunStepExecuteResponseDto>> {
  const definition = await getWorkflowDefinition(definitionId, userId);
  if (!definition) {
    return fail(404, '工作流不存在');
  }
  const step = definition.steps.find((item) => item.id === stepId);
  if (!step) {
    return fail(404, '工作流步骤不存在');
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

  if (step.type === 'paipan') {
    return executePaipanStep({
      userId,
      runtimeId,
      sessionId,
      step,
      clientId,
    });
  }
  return executeAiStep({
    userId,
    runtimeId,
    sessionId,
    step,
    messages,
    runInput,
  });
}

/** 找到某步最新的 AI 回复消息(id 约定 `wf-<stepId>-…_reply`)。 */
function findLatestStepReply(
  messages: NewMessage[],
  stepId: string,
): NewMessage | undefined {
  let latest: NewMessage | undefined;
  for (const message of messages) {
    if (
      !message.id.startsWith(`wf-${stepId}-`) ||
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
 * 保存某步 AI 产出的润色结果(改回复消息正文),供后续步骤渲染时读到润色版。
 *
 * @param userId 卦师用户 ID。
 * @param definitionId 工作流定义 ID(用于校验运行归属)。
 * @param sessionId 运行会话 ID。
 * @param stepId 步骤 ID。
 * @param content 润色后的正文。
 * @returns 成功响应;运行/产出缺失返回 404。
 */
export async function saveWorkflowStepOutput(
  userId: string,
  definitionId: string,
  sessionId: string,
  stepId: string,
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
  const reply = findLatestStepReply(messages, stepId);
  if (!reply) {
    return fail(404, '该步骤还没有可润色的产出');
  }
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
