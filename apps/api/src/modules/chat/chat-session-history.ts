import type {
  SessionBoardListResponseDto,
  SessionMessageListResponseDto,
} from '@fateclaw/contracts/chat';
import { toSessionMessageListResponseDto } from '#contracts-adapter/chat-contract';
import {
  getConversationLogByRequestId,
  getRecentMessages,
  getSessionMessageById,
  getSessionMessagesWithToolContext,
} from '#infrastructure/db';
import { getRedis } from '#infrastructure/redis';
import { sessionProcessingLockKey } from '#runtime/session-processing-lock';
import { fail, ok, type ServiceResult } from '#shared/service-result';
import { buildSessionBoardContexts } from './active-board-context.js';
import { getOwnedSession } from './chat-session-access.js';
import { resolveSessionContinuationState } from './chat-session-continuation.js';

export async function getOwnedChatSessionMessages(
  userId: string,
  sessionId: string,
  limit: number,
  before?: string,
  beforeId?: string,
): Promise<ServiceResult<SessionMessageListResponseDto>> {
  const sessionResult = await getOwnedSession(userId, sessionId);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  const session = sessionResult.data;
  const [messages, processingRequestId] = await Promise.all([
    getRecentMessages(
      session.account_id,
      limit,
      before,
      undefined,
      session.id,
      beforeId,
    ),
    getRedis().get(sessionProcessingLockKey(session.id)),
  ]);
  const continuation = await resolveSessionContinuationState(session);

  return ok(
    toSessionMessageListResponseDto(messages, Boolean(processingRequestId), {
      processingRequestId,
      continuationBlocked: continuation.blocked,
      continuationBlockReason: continuation.reason,
      continuationBlockMessage: continuation.message,
    }),
  );
}

export async function listOwnedChatSessionBoards(
  userId: string,
  sessionId: string,
): Promise<ServiceResult<SessionBoardListResponseDto>> {
  const sessionResult = await getOwnedSession(userId, sessionId);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  const session = sessionResult.data;
  const messages = await getSessionMessagesWithToolContext(
    session.account_id,
    session.id,
  );
  const seenMessageIds = new Set<string>();
  const boards = buildSessionBoardContexts(messages).flatMap((board) => {
    if (seenMessageIds.has(board.sourceMessageId)) return [];
    seenMessageIds.add(board.sourceMessageId);
    return [
      {
        source_message_id: board.sourceMessageId,
        skill: board.skill,
        title: board.artifactTitle?.trim() || board.skill,
        ...(board.createdAt ? { created_at: board.createdAt } : {}),
      },
    ];
  });

  return ok({ boards });
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
