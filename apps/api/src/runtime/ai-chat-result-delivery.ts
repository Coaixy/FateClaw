import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  getUserById,
  storeConversationLog,
  storeMessage,
  touchChatSession,
} from '#infrastructure/db';
import {
  incrementDailyMessageCount,
  incrementDailyTokens,
} from '#infrastructure/daily-usage';
import { logger } from '#infrastructure/logger';
import {
  withAgentInterruptionDelivery,
  withAgentResultDelivery,
} from '#infrastructure/repositories/agent-requests-repository';
import { settleBenefitTurn } from '#infrastructure/repositories/benefit-repository';
import { resolveMessageVisualizations } from '#modules/chat/conversation-visualization-service';
import {
  getUserIdFromWebChatRuntimeId,
  WEB_CHAT_ASSISTANT_NAME,
} from '#modules/chat/web-chat-runtime';
import { recordConversationLogFailure } from '#shared/conversation-log-metrics';
import { mapInternalErrorToPublicError } from '#shared/public-error';
import type {
  PendingInboxRequest,
  ResponseIpcPayload,
} from './ipc-payloads.js';
import { normalizeRuntimeTokenUsage } from './token-usage.js';

export async function resolveOwnerUserId(args: {
  accountId: string;
  pending?: PendingInboxRequest;
  payloadOwnerUserId?: string;
  db?: pg.PoolClient;
}): Promise<string | null> {
  if (args.pending?.ownerUserId) {
    return args.pending.ownerUserId;
  }
  if (args.payloadOwnerUserId?.trim()) {
    return args.payloadOwnerUserId.trim();
  }
  const webUserId = getUserIdFromWebChatRuntimeId(args.accountId);
  if (!webUserId) {
    return null;
  }
  if (args.db) {
    const { rows } = await args.db.query<{ id: string }>(
      'SELECT id FROM users WHERE id=$1',
      [webUserId],
    );
    return rows[0]?.id ?? null;
  }
  const user = await getUserById(webUserId);
  return user?.id ?? null;
}

export function resolveAiChatFinalSessionId(
  pending: PendingInboxRequest | undefined,
  payload: ResponseIpcPayload,
): string | undefined {
  return pending?.sessionId ?? payload.sessionId;
}

function resolveAiChatFinalUserMessageId(
  pending: PendingInboxRequest | undefined,
  payload: ResponseIpcPayload,
): string | undefined {
  return pending?.userMessageId ?? payload.userMessageId ?? payload.requestId;
}

async function incrementAiChatDailyMessageCount(
  ownerUserId: string | null,
  db?: pg.PoolClient,
): Promise<void> {
  if (!ownerUserId) return;
  const today = new Date().toISOString().slice(0, 10);
  await incrementDailyMessageCount(ownerUserId, today, db);
}

async function storeAiChatConversationLog(args: {
  accountId: string;
  payload: ResponseIpcPayload;
  db: pg.PoolClient;
}): Promise<void> {
  if (!args.payload.requestId) throw new Error('Missing result requestId');
  const logId = `clog-${createHash('sha256').update(args.accountId).update('\0').update(args.payload.requestId).digest('hex')}`;
  try {
    await storeConversationLog(
      {
        id: logId,
        accountId: args.accountId,
        requestId: args.payload.requestId,
        sessionId: args.payload.sessionId,
        transcript: args.payload.transcript ?? [],
        usage: args.payload.usage,
        model: args.payload.model,
        provider: args.payload.provider,
        traceEvents: args.payload.traceEvents,
        piSession: args.payload.piSession,
        agentGraph: args.payload.agentGraph,
      },
      args.db,
    );
  } catch (error) {
    recordConversationLogFailure(
      { accountId: args.accountId, requestId: args.payload.requestId },
      error,
    );
    throw error;
  }
}

async function recordAiChatTokenUsage(args: {
  accountId: string;
  pending?: PendingInboxRequest;
  payload: ResponseIpcPayload;
  db: pg.PoolClient;
}): Promise<void> {
  const normalizedUsage = normalizeRuntimeTokenUsage(args.payload.usage);
  if (normalizedUsage.totalTokens <= 0) return;

  const ownerUserId = await resolveOwnerUserId({
    accountId: args.accountId,
    pending: args.pending,
    payloadOwnerUserId: args.payload.ownerUserId,
    db: args.db,
  });
  if (!ownerUserId) return;

  const today = new Date().toISOString().slice(0, 10);
  await incrementDailyTokens(
    ownerUserId,
    today,
    normalizedUsage.promptTokens,
    normalizedUsage.completionTokens,
    normalizedUsage.totalTokens,
    args.db,
  );
  logger.info(
    {
      accountId: args.accountId,
      requestId: args.payload.requestId,
      promptTokens: normalizedUsage.promptTokens,
      completionTokens: normalizedUsage.completionTokens,
      totalTokens: normalizedUsage.totalTokens,
    },
    'AI Chat: 已记录 API 真实 token 用量',
  );
}

/**
 * 把最终响应落库为 assistant 消息。
 *
 * @returns 最终落库的那条消息 ID（error 消息或最后一条 reply）；
 *          缺少会话上下文或没有可落库文本时返回 null。
 *          调用方在计费结算完成后，用该 ID 把扣费金额回填进消息 metadata。
 */
async function storeAiChatFinalResponseMessages(args: {
  db?: pg.PoolClient;
  accountId: string;
  pending?: PendingInboxRequest;
  payload: ResponseIpcPayload;
  responseText: string;
  assistantMessages: string[];
  finalMetadata: Record<string, unknown>;
}): Promise<string | null> {
  if (
    args.db &&
    args.payload.requestId &&
    (args.pending?.llmRuntime?.poolKey === 'benefit' || !args.pending)
  ) {
    const benefit = await settleBenefitTurn(
      args.db,
      args.payload.requestId,
      args.payload.status === 'success',
      args.payload.publicReasonCode === 'user_stop',
    );
    if (benefit)
      Object.assign(args.finalMetadata, {
        pool_key: 'benefit',
        benefit_status: benefit,
        actual_charge_coins: 0,
        raw_charge_coins: 0,
      });
  }
  const sessionId = resolveAiChatFinalSessionId(args.pending, args.payload);
  const userMessageId = resolveAiChatFinalUserMessageId(
    args.pending,
    args.payload,
  );
  if (!sessionId || !args.payload.requestId || !userMessageId) {
    logger.warn(
      {
        accountId: args.accountId,
        requestId: args.payload.requestId,
        sessionId,
        userMessageId,
      },
      'AI Chat: 最终响应缺少会话上下文，跳过最终消息落库',
    );
    return null;
  }

  const ownerUserId = await resolveOwnerUserId({
    accountId: args.accountId,
    pending: args.pending,
    payloadOwnerUserId: args.payload.ownerUserId,
    db: args.db,
  });

  if (args.payload.status === 'error') {
    const content =
      args.responseText.trim() ||
      args.payload.publicErrorText?.trim() ||
      mapInternalErrorToPublicError(args.payload.error, {}).publicMessage;
    const errorMessageId = `${userMessageId}_error`;
    await storeMessage(
      {
        id: errorMessageId,
        account_id: args.accountId,
        user_id: ownerUserId,
        sender: args.accountId,
        sender_name: WEB_CHAT_ASSISTANT_NAME,
        content,
        timestamp: args.payload.timestamp || new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
        session_id: sessionId,
        metadata: {
          ...args.finalMetadata,
          kind: 'error',
          turn_complete: true,
          request_id: args.payload.requestId,
        },
      },
      args.db,
    );
    await touchChatSession(sessionId, args.db);
    return errorMessageId;
  }

  if (args.assistantMessages.length === 0) {
    logger.warn(
      {
        accountId: args.accountId,
        requestId: args.payload.requestId,
        sessionId,
      },
      'AI Chat: 最终响应没有 assistant 文本，仅更新会话完成状态',
    );
    await touchChatSession(sessionId, args.db);
    await incrementAiChatDailyMessageCount(ownerUserId, args.db);
    return null;
  }

  const replyTimestampBase = Date.now();
  let finalReplyMessageId: string | null = null;
  for (let index = 0; index < args.assistantMessages.length; index += 1) {
    const isFinalReply = index === args.assistantMessages.length - 1;
    const messageId =
      args.assistantMessages.length === 1
        ? `${userMessageId}_reply`
        : `${userMessageId}_reply_${index + 1}`;
    if (isFinalReply) {
      finalReplyMessageId = messageId;
    }
    const visualizationContext = await resolveMessageVisualizations(
      args.accountId,
      sessionId,
      args.assistantMessages[index],
      args.db,
    );
    const messageContext = [
      ...(isFinalReply ? (args.payload.skillContext ?? []) : []),
      ...visualizationContext,
    ];
    await storeMessage(
      {
        id: messageId,
        account_id: args.accountId,
        user_id: ownerUserId,
        sender: args.accountId,
        sender_name: WEB_CHAT_ASSISTANT_NAME,
        content: args.assistantMessages[index],
        timestamp: new Date(replyTimestampBase + index).toISOString(),
        is_from_me: true,
        is_bot_message: true,
        session_id: sessionId,
        tool_context: messageContext.length
          ? JSON.stringify(messageContext)
          : null,
        metadata: isFinalReply
          ? args.finalMetadata
          : {
              kind: 'assistant',
              request_id: args.payload.requestId,
            },
      },
      args.db,
    );
  }

  await touchChatSession(sessionId, args.db);
  await incrementAiChatDailyMessageCount(ownerUserId, args.db);
  return finalReplyMessageId;
}

export function persistAiChatFinalResult(args: {
  requestId: string;
  accountId: string;
  pending?: PendingInboxRequest;
  payload: ResponseIpcPayload;
  responseText: string;
  assistantMessages: string[];
  finalMetadata: Record<string, unknown>;
  synthetic: boolean;
}): Promise<string | null> {
  const { requestId, accountId, pending, payload, synthetic } = args;
  const storeMessages = (db: pg.PoolClient) =>
    storeAiChatFinalResponseMessages({ ...args, db });

  if (synthetic) {
    return withAgentInterruptionDelivery(
      requestId,
      accountId,
      storeMessages,
      payload,
    );
  }

  return withAgentResultDelivery(
    requestId,
    accountId,
    async (db) => {
      await storeAiChatConversationLog({ accountId, payload, db });
      await recordAiChatTokenUsage({ accountId, pending, payload, db });
      return storeMessages(db);
    },
    payload,
  );
}
