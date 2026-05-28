/**
 * AI 对话会话服务层。
 *
 * 负责会话归属校验、消息写入与 agent 调度，
 * 避免 route 直接依赖底层存储和运行时实现。
 */

import type {
  ChatSessionDto,
  ChatSessionSendResponseDto,
  SessionMessageListResponseDto,
} from '@fateclaw/contracts/chat';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import {
  createChatSession,
  deleteChatSession,
  getAccountsByUserId,
  getChatSession,
  getChatSessionsByUserId,
  getConversationLogByRequestId,
  getRecentMessages,
  getSessionMessageById,
  getSessionMessagesWithToolContext,
  getUserById,
  storeMessage,
  touchChatSession,
  updateChatSessionTitle,
} from '../../infrastructure/db.js';
import { incrementDailyMessageCount } from '../../infrastructure/daily-usage.js';
import { logger } from '../../infrastructure/logger.js';
import { getRedis } from '../../infrastructure/redis.js';
import { dispatchAiChatPrompt } from '../../runtime/resident-agent.js';
import { fail, ok, type ServiceResult } from '../../shared/service-result.js';
import {
  DEFAULT_OWNED_CHAT_SESSION_TITLE,
  normalizeOwnedChatSessionTitle,
} from '../../shared/chat-session-title-policy.js';
import type { ChatSession, NewMessage } from '../../shared/types.js';
import {
  toChatSessionDto,
  toSessionMessageListResponseDto,
} from '../../contracts-adapter/chat-contract.js';
import {
  buildActiveBoardContext,
  buildSessionBoardContexts,
} from './active-board-context.js';
import { buildStructuredInputForSession } from './message-handler.js';
import { resolveUserLlmRuntime } from '../system/system-config.js';
import {
  getWebChatRuntimeId,
  WEB_CHAT_ASSISTANT_NAME,
  WEB_CHAT_USER_NAME,
} from './web-chat-runtime.js';
import type { NormalizedChatSessionMessageInput } from './pasted-board-input.js';

const SESSION_PROCESSING_TTL_SECONDS = 2100;
const SESSION_PROCESSING_BUSY_ERROR = '上一条消息仍在处理中，请稍后再试';

function isPaymentRequiredError(errorMessage: string): boolean {
  return (
    errorMessage.includes('余额不足') || errorMessage.includes('免费对话额度')
  );
}

function sessionProcessingKey(sessionId: string): string {
  return `session:processing:${sessionId}`;
}

function createSessionProcessingClaim(): string {
  return `claim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function claimChatSessionProcessing(sessionId: string): Promise<boolean> {
  const result = await getRedis().set(
    sessionProcessingKey(sessionId),
    createSessionProcessingClaim(),
    'EX',
    SESSION_PROCESSING_TTL_SECONDS,
    'NX',
  );
  return result === 'OK';
}

async function releaseChatSessionProcessing(sessionId: string): Promise<void> {
  await getRedis().del(sessionProcessingKey(sessionId));
}

function buildSelectedBoardContext(message: NewMessage): boolean {
  const activeBoardContext = buildActiveBoardContext(message);
  return Boolean(activeBoardContext);
}

async function getOwnedSession(
  userId: string,
  sessionId: string,
): Promise<ServiceResult<ChatSession>> {
  const session = await getChatSession(sessionId);
  if (!session) {
    return fail(404, '会话不存在');
  }

  if (session.user_id !== userId) {
    return fail(403, '无权操作');
  }

  return ok(session);
}

async function resolveOwnedSoulAccountId(
  userId: string,
): Promise<string | undefined> {
  const accounts = await getAccountsByUserId(userId);
  return accounts[0]?.id;
}

export async function listChatSessionsForOwnedUser(
  userId: string,
): Promise<ServiceResult<ChatSessionDto[]>> {
  const sessions = await getChatSessionsByUserId(userId);
  return ok(sessions.map(toChatSessionDto));
}

export async function createChatSessionForOwnedUser(
  userId: string,
  title: string,
): Promise<ServiceResult<ChatSessionDto>> {
  const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedTitle = normalizeOwnedChatSessionTitle(title);
  const session = await createChatSession({
    id,
    accountId: getWebChatRuntimeId(userId),
    userId,
    title: normalizedTitle,
  });
  return ok(toChatSessionDto(session));
}

export async function renameOwnedChatSession(
  userId: string,
  sessionId: string,
  title: string,
): Promise<ServiceResult<SuccessResponse>> {
  const sessionResult = await getOwnedSession(userId, sessionId);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  await updateChatSessionTitle(sessionResult.data.id, title);
  return ok({ success: true });
}

export async function deleteOwnedChatSession(
  userId: string,
  sessionId: string,
): Promise<ServiceResult<SuccessResponse>> {
  const sessionResult = await getOwnedSession(userId, sessionId);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  await deleteChatSession(sessionResult.data.id);
  return ok({ success: true });
}

export async function getOwnedChatSessionMessages(
  userId: string,
  sessionId: string,
  limit: number,
  before?: string,
): Promise<ServiceResult<SessionMessageListResponseDto>> {
  const sessionResult = await getOwnedSession(userId, sessionId);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  const session = sessionResult.data;
  const [messages, processingRequestId] = await Promise.all([
    getRecentMessages(session.account_id, limit, before, undefined, session.id),
    getRedis().get(`session:processing:${session.id}`),
  ]);

  return ok(
    toSessionMessageListResponseDto(messages, Boolean(processingRequestId)),
  );
}

export async function getOwnedChatSessionQueryProcessSource(
  userId: string,
  sessionId: string,
  messageId: string,
): Promise<
  ServiceResult<{
    available: boolean;
    request_id: string | null;
    trace_events: unknown[];
  }>
> {
  const sessionResult = await getOwnedSession(userId, sessionId);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  const session = sessionResult.data;
  const message = await getSessionMessageById(
    session.account_id,
    session.id,
    messageId,
  );
  if (!message) {
    return fail(404, '消息不存在');
  }

  const metadata =
    message.metadata &&
    typeof message.metadata === 'object' &&
    !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : null;
  const requestId =
    metadata && typeof metadata.request_id === 'string'
      ? metadata.request_id
      : null;

  if (!requestId) {
    return ok({
      available: false,
      request_id: null,
      trace_events: [],
    });
  }

  const log = await getConversationLogByRequestId(requestId);
  if (!log || log.account_id !== session.account_id) {
    return ok({
      available: false,
      request_id: requestId,
      trace_events: [],
    });
  }

  return ok({
    available: true,
    request_id: requestId,
    trace_events: Array.isArray(log.trace_events) ? log.trace_events : [],
  });
}

export async function sendOwnedChatSessionMessage(
  userId: string,
  sessionId: string,
  input: NormalizedChatSessionMessageInput,
): Promise<ServiceResult<ChatSessionSendResponseDto>> {
  const sessionResult = await getOwnedSession(userId, sessionId);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  const session = sessionResult.data;
  const owner = await getUserById(userId);
  const shouldCountMessage = Boolean(owner);
  const msgId = `aichat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

  const processingClaimed = await claimChatSessionProcessing(session.id);
  if (!processingClaimed) {
    return fail(409, SESSION_PROCESSING_BUSY_ERROR);
  }

  try {
    const llmRuntime = await resolveUserLlmRuntime(userId);
    const userMessage: NewMessage = {
      id: msgId,
      account_id: session.account_id,
      user_id: userId,
      sender: userId,
      sender_name: WEB_CHAT_USER_NAME,
      content: input.content,
      metadata:
        input.inputKind === 'user_pasted_board'
          ? {
              kind: 'user_pasted_board',
              category: input.pastedBoard?.category,
            }
          : null,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
      session_id: session.id,
    };
    await storeMessage(userMessage);
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

    const structured = await buildStructuredInputForSession(
      {
        runtimeId: session.account_id,
        userName: WEB_CHAT_USER_NAME,
        assistantName: WEB_CHAT_ASSISTANT_NAME,
        soulAccountId: await resolveOwnedSoulAccountId(userId),
      },
      input.content,
      session.id,
      llmRuntime.model,
      llmRuntime.contextWindowTokens,
    );
    const output = await dispatchAiChatPrompt({
      accountId: session.account_id,
      userMessage: structured.userMessage,
      inputKind: input.inputKind,
      pastedBoard: input.pastedBoard,
      history: [],
      sessionBoardContexts,
      userName: structured.userName,
      assistantName: structured.assistantName,
      sessionId: session.id,
      llmRuntime,
    });

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
    const sessionTitle = normalizeOwnedChatSessionTitle(session.title);

    // 响应文本非空才落库（空文本说明内容已通过中间消息投递）
    if (replyText) {
      await storeMessage({
        id: `${msgId}_reply`,
        account_id: session.account_id,
        user_id: userId,
        sender: session.account_id,
        sender_name: WEB_CHAT_ASSISTANT_NAME,
        content: replyText,
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
        session_id: session.id,
        tool_context:
          output.skillContext && output.skillContext.length > 0
            ? JSON.stringify(output.skillContext)
            : null,
        metadata:
          output.metadata &&
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
              },
      });
    }

    await touchChatSession(session.id);

    if (shouldCountMessage && owner) {
      const today = new Date().toISOString().slice(0, 10);
      await incrementDailyMessageCount(owner.id, today);
    }

    return ok({
      text: replyText,
      session_title: sessionTitle || DEFAULT_OWNED_CHAT_SESSION_TITLE,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await releaseChatSessionProcessing(session.id);
    logger.error(
      { accountId: session.account_id, sessionId: session.id, err },
      'AI 对话: agent 调用失败',
    );

    if (isPaymentRequiredError(errorMessage)) {
      return fail(402, errorMessage);
    }

    return fail(502, errorMessage || '抱歉，AI 服务暂时不可用');
  }
}
