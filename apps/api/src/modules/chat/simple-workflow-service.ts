import type {
  MessageDto,
  SimpleWorkflowStartRequestDto,
  SimpleWorkflowStartResponseDto,
  SkillContextEntryDto,
} from '@fateclaw/contracts/chat';

import {
  createChatSession,
  getDefaultSimpleWorkflowPreset,
  storeMessage,
  touchChatSession,
} from '../../infrastructure/db.js';
import { logger } from '../../infrastructure/logger.js';
import {
  toChatSessionDto,
  toMessageDto,
} from '../../contracts-adapter/chat-contract.js';
import { fail, ok, type ServiceResult } from '../../shared/service-result.js';
import type {
  ChatSession,
  NewMessage,
  SimpleWorkflowKind,
  SimpleWorkflowPreset,
} from '../../shared/types.js';
import { normalizeOwnedChatSessionTitle } from '../../shared/chat-session-title-policy.js';
import { resolveSimpleWorkflowLlmRuntime } from '../system/system-config.js';
import { sendOwnedChatSessionMessage } from './chat-session-service.js';
import { DirectPaipanError, executeDirectPaipan } from './paipan-runtime.js';
import {
  getWebChatRuntimeId,
  WEB_CHAT_ASSISTANT_NAME,
  WEB_CHAT_USER_NAME,
} from './web-chat-runtime.js';

interface SimpleWorkflowPreparedInput {
  kind: SimpleWorkflowKind;
  paipanInput: Record<string, unknown>;
  displayQuestion: string;
  runtimePrompt: string;
  sessionTitle: string;
  requestSummary: string;
}

interface SimpleWorkflowBoardMessages {
  requestMessage: MessageDto;
  resultMessage: MessageDto;
}

const SIMPLE_WORKFLOW_KIND_LABELS: Record<SimpleWorkflowKind, string> = {
  divination: '占卜问事',
  natal: '命理分析',
};

function createMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function trimText(value: string | undefined): string {
  return value?.trim() ?? '';
}

function mergePaipanInput(
  preset: SimpleWorkflowPreset,
  input: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...preset.paipan_input_defaults,
    ...input,
  };
}

function buildSessionTitle(kind: SimpleWorkflowKind, topic: string): string {
  const prefix = SIMPLE_WORKFLOW_KIND_LABELS[kind];
  const normalizedTopic = topic.replace(/\s+/g, ' ').trim();
  const title = normalizedTopic
    ? `${prefix}：${normalizedTopic.slice(0, 24)}`
    : prefix;
  return normalizeOwnedChatSessionTitle(title);
}

function buildRuntimePrompt(args: {
  input: SimpleWorkflowStartRequestDto;
}): string {
  const { input } = args;
  if (input.kind === 'divination') {
    const background = trimText(input.background);
    return [trimText(input.question), background]
      .filter((line) => line.length > 0)
      .join('\n\n');
  }

  return trimText(input.questionDirection);
}

function prepareSimpleWorkflowInput(
  preset: SimpleWorkflowPreset,
  input: SimpleWorkflowStartRequestDto,
): ServiceResult<SimpleWorkflowPreparedInput> {
  if (input.kind === 'divination') {
    const question = trimText(input.question);
    if (!question) {
      return fail(400, '请先写下你想问的事情');
    }
    return ok({
      kind: 'divination',
      paipanInput: mergePaipanInput(preset, {}),
      displayQuestion: question,
      runtimePrompt: buildRuntimePrompt({ input }),
      sessionTitle: buildSessionTitle('divination', question),
      requestSummary: '简易模式：占卜问事',
    });
  }

  const solarDate = trimText(input.solarDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(solarDate)) {
    return fail(400, '请填写有效的公历出生日期');
  }
  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23) {
    return fail(400, '请填写出生时间；如果不确定，可先选择最接近的整点');
  }
  const minute = input.minute ?? 0;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    return fail(400, '出生分钟必须在 0 到 59 之间');
  }
  if (input.gender !== '男' && input.gender !== '女') {
    return fail(400, '请选择性别，用于八字起运计算');
  }
  const questionDirection = trimText(input.questionDirection);
  if (!questionDirection) {
    return fail(400, '请填写想看的问题方向');
  }

  return ok({
    kind: 'natal',
    paipanInput: mergePaipanInput(preset, {
      solarDate,
      hour: input.hour,
      minute,
      gender: input.gender,
    }),
    displayQuestion: `命理分析：${questionDirection}`,
    runtimePrompt: buildRuntimePrompt({ input }),
    sessionTitle: buildSessionTitle('natal', questionDirection),
    requestSummary: '简易模式：命理分析',
  });
}

function mapDirectPaipanError(error: unknown): ServiceResult<never> {
  if (error instanceof DirectPaipanError) {
    return fail(error.statusCode, error.message);
  }
  logger.error({ err: error }, '简易模式排盘执行失败');
  return fail(500, '排盘失败，请检查信息后重试');
}

function buildSimpleWorkflowBoardMessages(args: {
  userId: string;
  runtimeId: string;
  session: ChatSession;
  preset: SimpleWorkflowPreset;
  requestSummary: string;
  skillContextEntry: SkillContextEntryDto;
}): {
  requestMessage: NewMessage;
  resultMessage: NewMessage;
} {
  const now = new Date().toISOString();
  const requestMessage: NewMessage = {
    id: createMessageId('simple-workflow-req'),
    account_id: args.runtimeId,
    user_id: args.userId,
    sender: args.userId,
    sender_name: WEB_CHAT_USER_NAME,
    content: args.requestSummary,
    timestamp: now,
    is_from_me: false,
    is_bot_message: false,
    session_id: args.session.id,
    metadata: {
      kind: 'board_request',
      workflow: 'simple_workflow',
      board_skill: args.skillContextEntry.skill,
      simple_workflow_kind: args.preset.kind,
      simple_workflow_preset_id: args.preset.id,
    },
  };
  const resultMessage: NewMessage = {
    id: createMessageId('simple-workflow-board'),
    account_id: args.runtimeId,
    user_id: args.userId,
    sender: args.runtimeId,
    sender_name: WEB_CHAT_ASSISTANT_NAME,
    content: `已生成${args.skillContextEntry.artifactTitle ?? args.preset.entry_title}。接下来会基于此盘面进行解读。`,
    timestamp: new Date(Date.now() + 1).toISOString(),
    is_from_me: true,
    is_bot_message: true,
    session_id: args.session.id,
    tool_context: JSON.stringify([args.skillContextEntry]),
    metadata: {
      kind: 'board_result',
      workflow: 'simple_workflow',
      board_skill: args.skillContextEntry.skill,
      simple_workflow_kind: args.preset.kind,
      simple_workflow_preset_id: args.preset.id,
      model_policy: args.preset.model_policy,
      skill_bundle_ids: args.preset.skill_bundle_ids,
    },
  };
  return { requestMessage, resultMessage };
}

async function createSimpleWorkflowSession(args: {
  userId: string;
  preset: SimpleWorkflowPreset;
  prepared: SimpleWorkflowPreparedInput;
  skillContextEntry: SkillContextEntryDto;
}): Promise<{
  session: ChatSession;
  boardMessages: SimpleWorkflowBoardMessages;
}> {
  const runtimeId = getWebChatRuntimeId(args.userId);
  const session = await createChatSession({
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    accountId: runtimeId,
    userId: args.userId,
    title: args.prepared.sessionTitle,
  });
  const messages = buildSimpleWorkflowBoardMessages({
    userId: args.userId,
    runtimeId,
    session,
    preset: args.preset,
    requestSummary: args.prepared.requestSummary,
    skillContextEntry: args.skillContextEntry,
  });
  await storeMessage(messages.requestMessage);
  await storeMessage(messages.resultMessage);
  await touchChatSession(session.id);
  return {
    session,
    boardMessages: {
      requestMessage: toMessageDto(messages.requestMessage),
      resultMessage: toMessageDto(messages.resultMessage),
    },
  };
}

async function storeSimpleWorkflowAsyncFailureMessage(args: {
  userId: string;
  session: ChatSession;
  preset: SimpleWorkflowPreset;
  userMessageId: string;
  message: string;
}): Promise<void> {
  const content = [
    '盘面已生成，但 AI 解读暂时没有启动成功。',
    args.message ? `原因：${args.message}` : '',
    '你可以在当前会话里直接追问，我会继续参考上面的盘面。',
  ]
    .filter(Boolean)
    .join('\n');
  const failureMessage: NewMessage = {
    id: `${args.userMessageId}_reply`,
    account_id: args.session.account_id,
    user_id: args.userId,
    sender: args.session.account_id,
    sender_name: WEB_CHAT_ASSISTANT_NAME,
    content,
    timestamp: new Date().toISOString(),
    is_from_me: true,
    is_bot_message: true,
    session_id: args.session.id,
    metadata: {
      kind: 'final',
      workflow: 'simple_workflow',
      simple_workflow_kind: args.preset.kind,
      simple_workflow_preset_id: args.preset.id,
      simple_workflow_async_failed: true,
    },
  };
  await storeMessage(failureMessage);
  await touchChatSession(args.session.id);
}

async function enqueueSimpleWorkflowFirstTurn(args: {
  userId: string;
  session: ChatSession;
  preset: SimpleWorkflowPreset;
  prepared: SimpleWorkflowPreparedInput;
  boardMessageId: string;
  userMessageId: string;
}): Promise<void> {
  try {
    const llmRuntime = await resolveSimpleWorkflowLlmRuntime(
      args.userId,
      args.preset.model_policy,
    );
    const sendResult = await sendOwnedChatSessionMessage(
      args.userId,
      args.session.id,
      {
        content: args.prepared.displayQuestion,
        inputKind: 'normal',
        selectedBoardMessageId: args.boardMessageId,
      },
      {
        userMessageId: args.userMessageId,
        llmRuntimeOverride: llmRuntime,
        runtimeUserMessageOverride: args.prepared.runtimePrompt,
        authorizedSkillBundleIds: args.preset.skill_bundle_ids,
        plusGateBypass: 'simple_workflow_first_turn',
      },
    );

    if (!sendResult.ok) {
      logger.warn(
        {
          userId: args.userId,
          sessionId: args.session.id,
          presetId: args.preset.id,
          statusCode: sendResult.statusCode,
          error: sendResult.error,
        },
        '简易模式首轮 AI 请求未能入队，已保留会话和盘面',
      );
      await storeSimpleWorkflowAsyncFailureMessage({
        userId: args.userId,
        session: args.session,
        preset: args.preset,
        userMessageId: args.userMessageId,
        message: sendResult.error,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      {
        userId: args.userId,
        sessionId: args.session.id,
        presetId: args.preset.id,
        err: error,
      },
      '简易模式首轮 AI 请求后台启动失败',
    );
    await storeSimpleWorkflowAsyncFailureMessage({
      userId: args.userId,
      session: args.session,
      preset: args.preset,
      userMessageId: args.userMessageId,
      message,
    });
  }
}

/**
 * 启动简易模式 workflow。
 *
 * @param userId 当前登录用户 ID。
 * @param input 用户在简易模式表单提交的数据。
 * @returns 新建会话和盘面消息；首轮 AI 请求会在后台继续入队。
 */
export async function startSimpleWorkflowForOwnedUser(
  userId: string,
  input: SimpleWorkflowStartRequestDto,
): Promise<ServiceResult<SimpleWorkflowStartResponseDto>> {
  const preset = await getDefaultSimpleWorkflowPreset(input.kind);
  if (!preset) {
    return fail(503, '当前简易模式暂不可用，请稍后再试');
  }
  const prepared = prepareSimpleWorkflowInput(preset, input);
  if (!prepared.ok) {
    return prepared;
  }

  let skillContextEntry: SkillContextEntryDto;
  try {
    const execution = await executeDirectPaipan({
      accountId: getWebChatRuntimeId(userId),
      userId,
      skillDir: preset.paipan_skill,
      input: prepared.data.paipanInput,
    });
    skillContextEntry = execution.skillContextEntry;
  } catch (error) {
    return mapDirectPaipanError(error);
  }

  const created = await createSimpleWorkflowSession({
    userId,
    preset,
    prepared: prepared.data,
    skillContextEntry,
  });

  const userMessageId = createMessageId('simple-workflow-user');
  void enqueueSimpleWorkflowFirstTurn({
    userId,
    session: created.session,
    preset,
    prepared: prepared.data,
    boardMessageId: created.boardMessages.resultMessage.id,
    userMessageId,
  }).catch((error) => {
    logger.error(
      {
        userId,
        sessionId: created.session.id,
        presetId: preset.id,
        err: error,
      },
      '简易模式首轮 AI 请求后台任务兜底失败',
    );
  });

  return ok({
    session: toChatSessionDto(created.session),
    boardMessageId: created.boardMessages.resultMessage.id,
    assistantMessageId: `${userMessageId}_reply`,
  });
}
