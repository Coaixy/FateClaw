import crypto from 'node:crypto';
import type {
  ChatSessionSendResponseDto,
  MessageDto,
} from '@fateclaw/contracts/chat';
import type { SuccessResponse } from '@fateclaw/contracts/common';
import { toMessageDto } from '#contracts-adapter/chat-contract';
import {
  getChatSession,
  getSessionMessageById,
  getSessionMessagesWithToolContext,
  hasFinalAiChatSessionReply,
} from '#infrastructure/db';
import { logger } from '#infrastructure/logger';
import {
  BenefitAdmissionError,
  ModelSelectionError,
} from '#infrastructure/repositories/benefit-repository';
import { getPiSessionBase } from '#infrastructure/repositories/pi-session-frames-repository';
import {
  getRuntimeEntitlementSnapshot,
  type RuntimeEntitlementSnapshot,
} from '#modules/billing/entitlements';
import { BILLING_ARREARS_MESSAGE } from '#modules/billing/plans';
import { resolveUserLlmRuntime } from '#modules/system/system-config';
import { dispatchAiChatPrompt } from '#runtime/resident-agent';
import { cancelAiChatSessionRequest } from '#runtime/ipc-worker';
import {
  claimOrRefreshSessionProcessingLock,
  releaseSessionProcessingLock,
} from '#runtime/session-processing-lock';
import { normalizeOwnedChatSessionTitle } from '#shared/chat-session-title-policy';
import { fail, ok, type ServiceResult } from '#shared/service-result';
import type { ChatSession, NewMessage } from '#shared/types';
import {
  buildSessionBoardContexts,
  messageHasBoardContext,
  type SessionBoardContextDto,
} from './active-board-context.js';
import { getOwnedSession } from './chat-session-access.js';
import {
  resolveSessionContinuationState,
  SESSION_CONTINUATION_BLOCKED_MESSAGE,
} from './chat-session-continuation.js';
import type { NormalizedChatSessionMessageInput } from './pasted-board-input.js';
import {
  buildStructuredInputForSession,
  type StructuredInput,
} from './structured-input.js';
import {
  WEB_CHAT_ASSISTANT_NAME,
  WEB_CHAT_USER_NAME,
} from './web-chat-runtime.js';

const SESSION_PROCESSING_TTL_SECONDS = 2100;
const SESSION_PROCESSING_BUSY_ERROR = '上一条消息仍在处理中，请稍后再试';

/**
 * AI Chat turn 的来源元信息。
 *
 * @remarks 当前用于标记微信进入网页 session 的消息，后续前端可据此展示来源徽标。
 */
export interface ChatSessionTurnSourceMetadata {
  source_channel?: 'wechat';
  wechat_account_id?: string;
  sender_hash?: string;
}

/**
 * 发送 AI Chat turn 时可覆盖的内部选项。
 *
 * @remarks 微信入口会传入确定性消息 ID，避免 iLink 重试导致重复触发模型。
 */
export interface OwnedChatSessionTurnOptions {
  userMessageId?: string;
  sourceMetadata?: ChatSessionTurnSourceMetadata;
  /** 会话忙碌锁抢占成功后执行；微信入口用它发送非会话 ACK。 */
  onProcessingClaimed?: () => Promise<void>;
}

/**
 * AI Chat turn 的内部执行结果。
 *
 * @remarks HTTP API 继续只暴露 response；微信入口使用 finalAssistantMessages 同步最终落库内容。
 */
export interface OwnedChatSessionTurnResult {
  response: ChatSessionSendResponseDto;
  finalAssistantMessages: MessageDto[];
}

interface PreparedOwnedChatSessionTurn {
  userMessage: NewMessage;
  userId: string;
  session: ChatSession;
  input: NormalizedChatSessionMessageInput;
  msgId: string;
  requestId: string;
  llmRuntime: Awaited<ReturnType<typeof resolveUserLlmRuntime>>;
  structured: StructuredInput;
  sessionBoardContexts: SessionBoardContextDto[];
  entitlementSnapshot: RuntimeEntitlementSnapshot;
}

function isPaymentRequiredError(errorMessage: string): boolean {
  return (
    errorMessage.includes('余额不足') ||
    errorMessage.includes('积分不足') ||
    errorMessage.includes('免费对话额度') ||
    errorMessage.includes('欠费')
  );
}

function createAiChatRequestId(): string {
  return `aichat-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

async function claimChatSessionProcessing(
  sessionId: string,
  requestId: string,
): Promise<boolean> {
  return claimOrRefreshSessionProcessingLock(
    sessionId,
    requestId,
    SESSION_PROCESSING_TTL_SECONDS,
  );
}

async function releaseChatSessionProcessing(
  sessionId: string,
  requestId: string,
): Promise<void> {
  await releaseSessionProcessingLock(sessionId, requestId);
}

function buildSelectedBoardContext(message: NewMessage): boolean {
  return messageHasBoardContext(message);
}

function buildBoardFirstQuestionPrompt(args: {
  question: string;
  board: SessionBoardContextDto;
}): string {
  const title = args.board.artifactTitle?.trim() || '当前盘面';
  return [
    `已生成${title}。你可以直接提问，后续未切换主题时会参考此盘面。`,
    '',
    '【用户发送的问题】',
    args.question,
  ].join('\n');
}

async function buildRuntimeUserMessageForBoardFirstQuestion(args: {
  input: NormalizedChatSessionMessageInput;
  accountId: string;
  sessionId: string;
  sessionBoardContexts: SessionBoardContextDto[];
}): Promise<string> {
  if (args.input.inputKind !== 'normal') return args.input.content;
  const currentBoard = args.sessionBoardContexts.find(
    (board) => board.isCurrent,
  );
  if (
    !currentBoard?.createdAt ||
    !Number.isFinite(Date.parse(currentBoard.createdAt))
  )
    return args.input.content;
  if (
    await hasFinalAiChatSessionReply(
      args.accountId,
      args.sessionId,
      currentBoard.createdAt,
    )
  )
    return args.input.content;
  return buildBoardFirstQuestionPrompt({
    question: args.input.content,
    board: currentBoard,
  });
}

function normalizeAssistantReplyTexts(output: {
  text?: string;
  assistantMessages?: string[];
}): string[] {
  const assistantMessages = Array.isArray(output.assistantMessages)
    ? output.assistantMessages.map((message) => message.trim()).filter(Boolean)
    : [];
  if (assistantMessages.length > 0) {
    return assistantMessages;
  }
  const fallback = output.text?.trim();
  return fallback ? [fallback] : [];
}

function buildFinalReplyMetadata(output: {
  metadata?: unknown;
  requestId?: string;
}): Record<string, unknown> {
  return output.metadata &&
    typeof output.metadata === 'object' &&
    !Array.isArray(output.metadata)
    ? {
        ...output.metadata,
        kind: 'final',
        turn_complete: true,
        request_id: output.requestId,
      }
    : {
        kind: 'final',
        turn_complete: true,
        request_id: output.requestId,
      };
}

function mergeMessageMetadata(
  base: Record<string, unknown> | null,
  source?: ChatSessionTurnSourceMetadata,
): Record<string, unknown> | null {
  if (!source) return base;
  return {
    ...(base ?? {}),
    ...source,
  };
}

/**
 * 中断当前用户拥有的 AI Chat 会话输出。
 *
 * @param userId 当前登录平台用户 ID。
 * @param sessionId 需要中断的 AI Chat 会话 ID。
 * @returns 成功响应；没有正在执行的请求也视为幂等成功。
 */
export async function cancelOwnedChatSessionMessage(
  userId: string,
  sessionId: string,
): Promise<ServiceResult<SuccessResponse>> {
  const sessionResult = await getOwnedSession(userId, sessionId);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  await cancelAiChatSessionRequest(
    sessionResult.data.id,
    sessionResult.data.account_id,
  );
  return ok({ success: true });
}

export async function sendOwnedChatSessionMessage(
  userId: string,
  sessionId: string,
  input: NormalizedChatSessionMessageInput,
  options: OwnedChatSessionTurnOptions = {},
): Promise<ServiceResult<ChatSessionSendResponseDto>> {
  const prepared = await prepareOwnedChatSessionTurn(
    userId,
    sessionId,
    input,
    options,
  );
  if (!prepared.ok) {
    return prepared;
  }

  return enqueuePreparedOwnedChatSessionTurn(prepared.data);
}

/**
 * 执行当前用户拥有的 AI Chat 会话一轮对话。
 *
 * @param userId - 会话归属用户。
 * @param sessionId - chat_sessions.id。
 * @param input - 标准化后的用户输入。
 * @param options - 内部调用选项；微信入口用于传入来源与幂等消息 ID。
 * @returns 包含 HTTP 响应数据和最终已落库 assistant 消息的服务结果。
 */
export async function runOwnedChatSessionTurn(
  userId: string,
  sessionId: string,
  input: NormalizedChatSessionMessageInput,
  options: OwnedChatSessionTurnOptions = {},
): Promise<ServiceResult<OwnedChatSessionTurnResult>> {
  const prepared = await prepareOwnedChatSessionTurn(
    userId,
    sessionId,
    input,
    options,
  );
  if (!prepared.ok) {
    return prepared;
  }

  return completeOwnedChatSessionTurn(prepared.data);
}

async function prepareOwnedChatSessionTurn(
  userId: string,
  sessionId: string,
  input: NormalizedChatSessionMessageInput,
  options: OwnedChatSessionTurnOptions = {},
): Promise<ServiceResult<PreparedOwnedChatSessionTurn>> {
  const sessionResult = await getOwnedSession(userId, sessionId);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  const session = sessionResult.data;
  const continuation = await resolveSessionContinuationState(session);
  if (continuation.blocked) {
    return fail(
      410,
      continuation.message ?? SESSION_CONTINUATION_BLOCKED_MESSAGE,
    );
  }

  const entitlement = await getRuntimeEntitlementSnapshot(userId);
  // Benefit admission uses its own allowance; wallet debt gates paid execution only.
  if (session.model_pool_key !== 'benefit' && entitlement.wallet.inArrears) {
    return fail(402, BILLING_ARREARS_MESSAGE);
  }
  const msgId =
    options.userMessageId ??
    `aichat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (options.userMessageId) {
    const existingMessage = await getSessionMessageById(
      session.account_id,
      session.id,
      options.userMessageId,
    );
    if (existingMessage) {
      return fail(409, '消息已处理');
    }
  }
  const selectedBoardMessageId = input.selectedBoardMessageId;
  const selectedBoardContext = selectedBoardMessageId
    ? await (async () => {
        const selectedBoardMessage = await getSessionMessageById(
          session.account_id,
          session.id,
          selectedBoardMessageId,
        );
        if (!selectedBoardMessage) {
          return fail(404, '指定的盘面消息不存在');
        }
        if (!buildSelectedBoardContext(selectedBoardMessage)) {
          return fail(400, '指定的消息不包含可用盘面');
        }
        return ok(true);
      })()
    : null;
  if (selectedBoardContext && !selectedBoardContext.ok) {
    return selectedBoardContext;
  }

  const requestId = createAiChatRequestId();
  const processingClaimed = await claimChatSessionProcessing(
    session.id,
    requestId,
  );
  if (!processingClaimed) {
    return fail(409, SESSION_PROCESSING_BUSY_ERROR);
  }
  try {
    await options.onProcessingClaimed?.();
  } catch (err) {
    logger.warn(
      { accountId: session.account_id, sessionId: session.id, err },
      'AI 对话: 会话抢占后的回调执行失败',
    );
  }

  try {
    // A model switch uses the same session lock; re-read after acquiring it.
    const currentSession = await getChatSession(session.id);
    if (!currentSession || currentSession.user_id !== userId)
      throw new Error('会话不存在或无权访问');
    const llmRuntime = await resolveUserLlmRuntime(
      userId,
      currentSession.model_pool_key ?? 'official',
    );
    if (llmRuntime.billingMode === 'metered' && entitlement.wallet.inArrears)
      throw new Error(BILLING_ARREARS_MESSAGE);
    const userMessage: NewMessage = {
      id: msgId,
      account_id: session.account_id,
      user_id: userId,
      sender: userId,
      sender_name: WEB_CHAT_USER_NAME,
      content: input.content,
      metadata: mergeMessageMetadata(
        input.inputKind === 'user_pasted_board'
          ? {
              kind: 'user_pasted_board',
              category: input.pastedBoard?.category,
            }
          : null,
        options.sourceMetadata,
      ),
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
      session_id: session.id,
    };
    const boardMessages = await getSessionMessagesWithToolContext(
      session.account_id,
      session.id,
    );
    const sessionBoardContexts = buildSessionBoardContexts(boardMessages, {
      selectedBoardMessageId,
      currentPastedBoard:
        input.inputKind === 'user_pasted_board' && input.pastedBoard
          ? {
              sourceMessageId: msgId,
              pastedBoard: input.pastedBoard,
              createdAt: userMessage.timestamp,
            }
          : undefined,
    });
    const runtimeUserMessage =
      await buildRuntimeUserMessageForBoardFirstQuestion({
        input,
        accountId: session.account_id,
        sessionId: session.id,
        sessionBoardContexts,
      });

    const structured = await buildStructuredInputForSession(
      {
        runtimeId: session.account_id,
        userName: WEB_CHAT_USER_NAME,
        assistantName: WEB_CHAT_ASSISTANT_NAME,
        soulUserId: userId,
      },
      runtimeUserMessage,
      session.id,
      llmRuntime.model,
      llmRuntime.contextWindowTokens,
    );

    return ok({
      userId,
      userMessage,
      session,
      input,
      msgId,
      requestId,
      llmRuntime,
      structured,
      sessionBoardContexts,
      entitlementSnapshot: entitlement,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await releaseChatSessionProcessing(session.id, requestId);
    logger.error(
      { accountId: session.account_id, sessionId: session.id, err },
      'AI 对话: 请求准备失败',
    );

    if (err instanceof ModelSelectionError) return fail(409, errorMessage);
    if (err instanceof BenefitAdmissionError)
      return fail(err.statusCode, errorMessage);
    if (isPaymentRequiredError(errorMessage)) {
      return fail(402, errorMessage);
    }

    return fail(502, errorMessage || '抱歉，AI 服务暂时不可用');
  }
}

async function readPersistedChatSessionTitle(
  sessionId: string,
): Promise<string | undefined> {
  try {
    const session = await getChatSession(sessionId);
    return session ? normalizeOwnedChatSessionTitle(session.title) : undefined;
  } catch (err) {
    // A title refresh must not fail an admitted turn or release its processing lock.
    logger.warn({ sessionId, err }, 'Failed to refresh chat session title');
    return undefined;
  }
}

async function dispatchPreparedChatTurn(
  prepared: PreparedOwnedChatSessionTurn,
  waitForResponse?: false,
) {
  const { input, llmRuntime, msgId, requestId, session, structured } = prepared;
  return dispatchAiChatPrompt({
    accountId: session.account_id,
    userMessage: structured.userMessage,
    inputKind: input.inputKind,
    pastedBoard: input.pastedBoard,
    history: [],
    sessionBoardContexts: prepared.sessionBoardContexts,
    piSessionBase:
      (await getPiSessionBase(session.id, session.account_id)) ?? null,
    userName: structured.userName,
    assistantName: structured.assistantName,
    personaPrompt: structured.personaPrompt,
    sessionId: session.id,
    userMessageId: msgId,
    messageToPersist: prepared.userMessage,
    requestId,
    llmRuntime,
    entitlementSnapshot: prepared.entitlementSnapshot,
    ...(waitForResponse === false ? { waitForResponse } : {}),
  });
}

async function enqueuePreparedOwnedChatSessionTurn(
  prepared: PreparedOwnedChatSessionTurn,
): Promise<ServiceResult<ChatSessionSendResponseDto>> {
  const { requestId, session } = prepared;

  try {
    const output = await dispatchPreparedChatTurn(prepared, false);

    if (output.status === 'error') {
      const errorMessage =
        output.publicErrorText || output.text || output.error || 'AI 处理失败';
      await releaseChatSessionProcessing(session.id, requestId);
      return fail(
        isPaymentRequiredError(errorMessage) ? 402 : 502,
        errorMessage,
      );
    }

    return ok({
      text: '',
      accepted: true,
      request_id: output.requestId || requestId,
      session_title: await readPersistedChatSessionTitle(session.id),
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await releaseChatSessionProcessing(session.id, requestId);
    logger.error(
      { accountId: session.account_id, sessionId: session.id, err },
      'AI 对话: 请求入队失败',
    );

    if (err instanceof ModelSelectionError) return fail(409, errorMessage);
    if (err instanceof BenefitAdmissionError)
      return fail(err.statusCode, errorMessage);
    if (isPaymentRequiredError(errorMessage)) {
      return fail(402, errorMessage);
    }

    return fail(502, errorMessage || '抱歉，AI 服务暂时不可用');
  }
}

async function completeOwnedChatSessionTurn(
  prepared: PreparedOwnedChatSessionTurn,
): Promise<ServiceResult<OwnedChatSessionTurnResult>> {
  const { msgId, requestId, session } = prepared;

  try {
    const output = await dispatchPreparedChatTurn(prepared);

    if (output.status === 'error') {
      const errorMessage =
        output.publicErrorText || output.text || output.error || 'AI 处理失败';
      logger.warn(
        {
          accountId: session.account_id,
          sessionId: session.id,
          error: output.error,
        },
        'AI 对话: agent 返回错误',
      );
      return fail(
        isPaymentRequiredError(errorMessage) ? 402 : 502,
        errorMessage,
      );
    }

    const replyText = output.text || '';
    const replyTexts = normalizeAssistantReplyTexts(output);
    const replyTimestampBase = Date.now();
    const finalAssistantMessages: MessageDto[] = [];

    // 多轮 runtime 可能返回多条 assistant 文本；这里仅组装给同步调用方，最终落库由 outbox handler 统一完成。
    for (let index = 0; index < replyTexts.length; index += 1) {
      const isFinalReply = index === replyTexts.length - 1;
      const assistantMessage: NewMessage = {
        id:
          replyTexts.length === 1
            ? `${msgId}_reply`
            : `${msgId}_reply_${index + 1}`,
        account_id: session.account_id,
        user_id: prepared.userId,
        sender: session.account_id,
        sender_name: WEB_CHAT_ASSISTANT_NAME,
        content: replyTexts[index],
        timestamp: new Date(replyTimestampBase + index).toISOString(),
        is_from_me: true,
        is_bot_message: true,
        session_id: session.id,
        tool_context:
          isFinalReply && output.skillContext && output.skillContext.length > 0
            ? JSON.stringify(output.skillContext)
            : null,
        metadata: isFinalReply
          ? buildFinalReplyMetadata(output)
          : {
              kind: 'assistant',
              request_id: output.requestId,
            },
      };
      finalAssistantMessages.push(toMessageDto(assistantMessage));
    }

    return ok({
      response: {
        text: replyText,
        session_title: await readPersistedChatSessionTitle(session.id),
        request_id: output.requestId || requestId,
      },
      finalAssistantMessages,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await releaseChatSessionProcessing(session.id, requestId);
    logger.error(
      { accountId: session.account_id, sessionId: session.id, err },
      'AI 对话: agent 调用失败',
    );

    if (err instanceof ModelSelectionError) return fail(409, errorMessage);
    if (err instanceof BenefitAdmissionError)
      return fail(err.statusCode, errorMessage);
    if (isPaymentRequiredError(errorMessage)) {
      return fail(402, errorMessage);
    }

    return fail(502, errorMessage || '抱歉，AI 服务暂时不可用');
  }
}
