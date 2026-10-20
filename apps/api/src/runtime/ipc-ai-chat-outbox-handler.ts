import {
  recordAgentTiming,
  recordAgentTraceTimings,
} from './agent-performance.js';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { settleBenefitTurn } from '#infrastructure/repositories/benefit-repository';
import { resolveMessageVisualizations } from '#modules/chat/conversation-visualization-service';
import {
  withAgentInterruptionDelivery,
  withAgentResultDelivery,
} from '#infrastructure/repositories/agent-requests-repository';
/**
 * AI Chat 专属 outbox 队列处理。
 *
 * 与 ipc-outbox-handler.ts 的区别：
 * - 永远不发微信（不调用 ilinkSendMessage）
 * - 中间消息和最终响应都直接落库到 session
 * - 逻辑更简单，去掉所有 autoDeliver 判断
 */

import {
  getUserById,
  mergeMessageMetadata,
  storeConversationLog,
  storeMessage,
  touchChatSession,
} from '#infrastructure/db';
import {
  incrementDailyMessageCount,
  incrementDailyTokens,
} from '#infrastructure/daily-usage';
import {
  InvalidAiChatPayloadError,
  bindIpcPayloadIdentity,
  PendingInboxRequest,
  ProgressIpcPayload,
  ResponseIpcPayload,
  SendMessageIpcPayload,
  releaseSessionProcessingLock,
  resolveAccountId,
  validateMessagePayload,
  validateProgressPayload,
  validateResponsePayload,
} from './ipc-payloads.js';
import { normalizeRuntimeTokenUsage } from './token-usage.js';
import { releaseLocalAgent } from './local-runner.js';
import { logger } from '#infrastructure/logger';
import {
  publishAiChatStreamEvent,
  streamEventFromMessagePayload,
  streamEventFromProgressPayload,
  streamEventFromResponsePayload,
} from './ai-chat-stream.js';
import {
  recordConversationLogFailure,
  recordConversationLogSuccess,
} from '#shared/conversation-log-metrics';
import { mapInternalErrorToPublicError } from '#shared/public-error';
import {
  settleBillingReservationDetailed,
  recoverStalePendingReservation,
  type BillingSettlementSummary,
} from '#modules/billing/plans';
import {
  getUserIdFromWebChatRuntimeId,
  WEB_CHAT_ASSISTANT_NAME,
} from '#modules/chat/web-chat-runtime';

function formatTokens(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
}

function appendFinalTurnMarker(
  text: string,
  usage?: { promptTokens?: number; completionTokens?: number },
): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  const inTokens = usage?.promptTokens ?? 0;
  const outTokens = usage?.completionTokens ?? 0;
  const marker = `📥 ${formatTokens(inTokens)} · 📤 ${formatTokens(outTokens)} Finished`;

  return `${trimmed}\n\n${marker}`;
}

function appendIntermediateMarker(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return `${trimmed}\n\n💭 Thinking...`;
}

async function releaseLocalAgentLeaseForPending(
  pending: PendingInboxRequest | undefined,
  context: { accountId?: string; requestId?: string; reason: string },
): Promise<void> {
  if (!pending?.localAgentLeaseId) return;
  await releaseLocalAgent(pending.localAgentLeaseId).catch((err) => {
    logger.warn(
      {
        accountId: context.accountId ?? pending.accountId,
        requestId: context.requestId,
        reason: context.reason,
        err,
      },
      '释放本地 agent-runtime 租约失败',
    );
  });
}

function resolveAiChatResponseText(payload: ResponseIpcPayload): string {
  return (
    payload.publicErrorText ||
    payload.text ||
    (payload.status === 'error'
      ? mapInternalErrorToPublicError(payload.error, {}).publicMessage
      : '')
  ).trim();
}

function extractTranscriptAssistantMessages(transcript: unknown): string[] {
  if (!Array.isArray(transcript)) return [];
  return transcript.flatMap((event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return [];
    }
    const record = event as Record<string, unknown>;
    if (record.type !== 'assistant' || typeof record.text !== 'string') {
      return [];
    }
    const text = record.text.trim();
    return text ? [text] : [];
  });
}

function buildAssistantMessagesForResponse(args: {
  payload: ResponseIpcPayload;
  responseText: string;
  finalText: string;
}): string[] {
  const transcriptMessages = extractTranscriptAssistantMessages(
    args.payload.transcript,
  );
  if (transcriptMessages.length === 0) {
    return args.finalText ? [args.finalText] : [];
  }

  if (!args.finalText) {
    return transcriptMessages;
  }

  const messages = [...transcriptMessages];
  const lastIndex = messages.length - 1;
  if (args.responseText && messages[lastIndex] === args.responseText) {
    messages[lastIndex] = args.finalText;
    return messages;
  }

  if (messages[lastIndex] === args.finalText) {
    return messages;
  }

  return [...messages, args.finalText];
}

function resolvePendingDurationMs(
  pending?: PendingInboxRequest,
): number | undefined {
  if (typeof pending?.startedAtMs !== 'number') return undefined;
  const durationMs = Date.now() - pending.startedAtMs;
  if (!Number.isFinite(durationMs) || durationMs < 0) return undefined;
  return Math.round(durationMs);
}

function buildFinalMetadata(args: {
  payload: ResponseIpcPayload;
  durationMs?: number;
  billing?: BillingSettlementSummary | null;
}): Record<string, unknown> {
  const billing = args.billing;
  return {
    ...(args.payload.metadata &&
    typeof args.payload.metadata === 'object' &&
    !Array.isArray(args.payload.metadata)
      ? args.payload.metadata
      : {}),
    kind: 'final',
    turn_complete: true,
    request_id: args.payload.requestId,
    ...(typeof args.durationMs === 'number'
      ? { duration_ms: args.durationMs }
      : {}),
    ...(billing
      ? {
          actual_charge_coins: billing.actualChargeCoins,
          raw_charge_coins: billing.rawChargeCoins,
        }
      : {}),
  };
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

async function settleAiChatBilling(args: {
  accountId: string;
  pending?: PendingInboxRequest;
  payload: ResponseIpcPayload;
}): Promise<BillingSettlementSummary | null> {
  if (!args.payload.requestId) return null;
  const normalizedUsage = normalizeRuntimeTokenUsage(args.payload.usage);
  if (!args.pending?.llmRuntime) {
    return recoverStalePendingReservation({
      requestId: args.payload.requestId,
      promptTokens: normalizedUsage.promptTokens,
      completionTokens: normalizedUsage.completionTokens,
    });
  }
  if (args.pending.llmRuntime.billingMode !== 'metered') return null;

  const billing = await settleBillingReservationDetailed({
    requestId: args.payload.requestId,
    runtime: args.pending.llmRuntime,
    promptTokens: normalizedUsage.promptTokens,
    completionTokens: normalizedUsage.completionTokens,
  });
  logger.info(
    {
      accountId: args.accountId,
      requestId: args.payload.requestId,
      actualChargeCoins: billing.actualChargeCoins,
    },
    'AI Chat: 已完成模型 Token 扣费结算',
  );
  return billing;
}

async function resolvePendingAiChatResponse(args: {
  accountId: string;
  pending?: PendingInboxRequest;
  pendingRequests: Map<string, PendingInboxRequest>;
  payload: ResponseIpcPayload;
  finalText: string;
  assistantMessages: string[];
  finalMetadata: Record<string, unknown>;
}): Promise<void> {
  if (!args.pending) return;

  clearTimeout(args.pending.timeout);
  args.pendingRequests.delete(args.payload.requestId!);
  if (args.pending.sessionId) {
    await releaseSessionProcessingLock(
      args.pending.sessionId,
      args.pending.sessionProcessingRequestId ?? args.payload.requestId,
    ).catch(() => {});
  }
  await releaseLocalAgentLeaseForPending(args.pending, {
    accountId: args.accountId,
    requestId: args.payload.requestId,
    reason: 'ai_chat_response',
  });
  logger.info(
    {
      accountId: args.accountId,
      requestId: args.payload.requestId,
      status: args.payload.status || 'success',
      sessionId: args.pending.sessionId,
    },
    'AI Chat: 请求已完成',
  );
  args.pending.resolve({
    requestId: args.payload.requestId!,
    status: args.payload.status || 'success',
    text: args.finalText,
    assistantMessages: args.assistantMessages,
    error: args.payload.error,
    publicErrorText: args.payload.publicErrorText,
    publicReasonCode: args.payload.publicReasonCode,
    metadata: args.finalMetadata,
    // 回传真实 token 用量（args.payload 即 payloadForUsage，usage 已归一化）；供对外 API 回填 OpenAI usage。
    usage: normalizeRuntimeTokenUsage(args.payload.usage),
    skillContext: args.payload.skillContext,
  });
}

async function resolveOwnerUserId(args: {
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

function normalizeMessageIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || 'unknown';
}

function resolveAiChatFinalSessionId(
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

async function releaseCompletedAiChatSessionLock(args: {
  pending?: PendingInboxRequest;
  payload: ResponseIpcPayload;
  sessionId?: string;
}): Promise<void> {
  if (!args.sessionId || !args.payload.requestId) return;
  await releaseSessionProcessingLock(
    args.sessionId,
    args.pending?.sessionProcessingRequestId ?? args.payload.requestId,
  ).catch(() => {});
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

function buildProgressMessageId(payload: ProgressIpcPayload): string {
  const metadata =
    payload.metadata && typeof payload.metadata === 'object'
      ? payload.metadata
      : {};
  const isToolTrace = metadata.kind === 'tool_trace';
  const toolCallId =
    typeof metadata.tool_call_id === 'string'
      ? metadata.tool_call_id
      : undefined;

  if (isToolTrace && payload.requestId && toolCallId) {
    return [
      'aichat-tool',
      normalizeMessageIdPart(payload.requestId),
      normalizeMessageIdPart(toolCallId),
    ].join('-');
  }

  // 思考块：每回合一条，用 requestId + 回合序号做稳定 id，避免重试重复落库。
  if (metadata.kind === 'thinking' && payload.requestId) {
    const turnIndex =
      typeof metadata.turn_index === 'number' ? metadata.turn_index : 0;
    return [
      'aichat-thinking',
      normalizeMessageIdPart(payload.requestId),
      String(turnIndex),
    ].join('-');
  }

  return payload.eventId
    ? `aichat-progress-${createHash('sha256')
        .update(payload.accountId ?? '')
        .update('\0')
        .update(payload.requestId ?? '')
        .update('\0')
        .update(payload.eventId)
        .digest('hex')}`
    : `aichat-progress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * AI Chat 专属 outbox handler 主入口。
 * 消息永远不发微信，直接落库到 session。
 */
export async function processAiChatOutboxPayload(
  payload: unknown,
  fallbackAccountId: string | undefined,
  pendingRequests: Map<string, PendingInboxRequest>,
): Promise<void> {
  if (validateResponsePayload(payload)) {
    await processAiChatResponse(
      bindIpcPayloadIdentity(payload, fallbackAccountId, pendingRequests),
      fallbackAccountId,
      pendingRequests,
    );
    return;
  }
  if (validateMessagePayload(payload)) {
    await processAiChatMessage(
      bindIpcPayloadIdentity(payload, fallbackAccountId, pendingRequests),
      fallbackAccountId,
      pendingRequests,
    );
    return;
  }
  if (validateProgressPayload(payload)) {
    await processAiChatProgress(
      bindIpcPayloadIdentity(payload, fallbackAccountId, pendingRequests),
      fallbackAccountId,
      pendingRequests,
    );
    return;
  }
  throw new InvalidAiChatPayloadError('Invalid AI Chat outbox envelope');
}

/**
 * 处理 AI Chat 最终响应。
 * - 不发微信
 * - 落库到 session
 * - 记录 token 用量
 * - resolve pending
 */
async function processAiChatResponse(
  payload: ResponseIpcPayload,
  fallbackAccountId: string | undefined,
  pendingRequests: Map<string, PendingInboxRequest>,
): Promise<void> {
  const pending = payload.requestId
    ? pendingRequests.get(payload.requestId)
    : undefined;
  try {
    const accountId = await resolveAccountId(
      payload.accountId,
      fallbackAccountId,
    );
    if (!accountId) {
      throw new Error('无法为 AI Chat response 解析 accountId');
    }

    const normalizedPayloadUsage = normalizeRuntimeTokenUsage(payload.usage);
    const hasRealUsage = normalizedPayloadUsage.totalTokens > 0;
    const payloadForUsage = hasRealUsage
      ? { ...payload, usage: normalizedPayloadUsage }
      : payload;

    const text = resolveAiChatResponseText(payload);
    if (!text && payload.status === 'error') {
      throw new Error('AI Chat response 文本为空');
    }

    const finalText = text
      ? appendFinalTurnMarker(text, payloadForUsage.usage)
      : '';
    const assistantMessages = buildAssistantMessagesForResponse({
      payload: payloadForUsage,
      responseText: text,
      finalText,
    });
    const durationMs = resolvePendingDurationMs(pending);
    const sessionId = resolveAiChatFinalSessionId(pending, payloadForUsage);

    logger.info(
      {
        accountId,
        requestId: payload.requestId,
        status: payload.status,
        sessionId,
      },
      'AI Chat: 处理最终响应（不发微信）',
    );

    if (!payload.requestId) throw new Error('Missing result requestId');
    const finalMetadata = buildFinalMetadata({
      payload: payloadForUsage,
      durationMs,
    });
    const deliveryStartedAt = Date.now();
    const runtimeTraceEvents = payloadForUsage.traceEvents;
    payloadForUsage.traceEvents = [
      ...(pending?.timings ?? []),
      ...(runtimeTraceEvents ?? []),
    ];
    // The delivery receipt, actual usage, and messages commit together. Retries
    // skip these effects; billing remains recoverable from the durable usage log.
    const synthetic =
      (payloadForUsage.metadata as Record<string, unknown> | undefined)
        ?.synthetic_terminal === true;
    const finalMessageId = synthetic
      ? await withAgentInterruptionDelivery(
          payload.requestId,
          accountId,
          (db) =>
            storeAiChatFinalResponseMessages({
              accountId,
              pending,
              payload: payloadForUsage,
              responseText: text,
              assistantMessages,
              finalMetadata,
              db,
            }),
          payloadForUsage,
        )
      : await withAgentResultDelivery(
          payload.requestId,
          accountId,
          async (db) => {
            await storeAiChatConversationLog({
              accountId,
              payload: payloadForUsage,
              db,
            });
            await recordAiChatTokenUsage({
              accountId,
              pending,
              payload: payloadForUsage,
              db,
            });
            return storeAiChatFinalResponseMessages({
              accountId,
              pending,
              payload: payloadForUsage,
              responseText: text,
              assistantMessages,
              finalMetadata,
              db,
            });
          },
          payloadForUsage,
        );
    if (synthetic && !finalMessageId) return;
    if (!synthetic) {
      recordConversationLogSuccess();
      recordAgentTiming('delivery', Date.now() - deliveryStartedAt);
      recordAgentTraceTimings(runtimeTraceEvents);
    }

    let billing: BillingSettlementSummary | null = null;
    try {
      billing = synthetic
        ? null
        : await settleAiChatBilling({
            accountId,
            pending,
            payload: payloadForUsage,
          });
    } catch (settleErr) {
      logger.error(
        { accountId, requestId: payload.requestId, err: settleErr },
        'AI Chat: 消息已交付但计费结算失败，预留保持 pending 交由 billing-sweeper 补收',
      );
    }
    if (billing) {
      const billingMetadata = {
        actual_charge_coins: billing.actualChargeCoins,
        raw_charge_coins: billing.rawChargeCoins,
      };
      // 流事件与 resolve 结果直接携带扣费金额；已落库的最终消息则回填 metadata，
      // 保证 web 端历史里的扣费展示不受「先落库后结算」的顺序调整影响。
      Object.assign(finalMetadata, billingMetadata);
      if (finalMessageId) {
        await mergeMessageMetadata(
          finalMessageId,
          accountId,
          billingMetadata,
        ).catch((err) => {
          logger.warn(
            { accountId, requestId: payload.requestId, finalMessageId, err },
            'AI Chat: 回填最终消息的扣费 metadata 失败（不影响计费与交付）',
          );
        });
      }
    }
    await releaseCompletedAiChatSessionLock({
      pending,
      payload: payloadForUsage,
      sessionId,
    });

    await publishAiChatStreamEvent({
      sessionId,
      event: streamEventFromResponsePayload({
        payload: payloadForUsage,
        accountId,
        sessionId,
        text: finalText || text,
        metadata: finalMetadata,
      }),
    }).catch((err) => {
      logger.warn(
        { err, requestId: payload.requestId },
        'Result committed; stream notification failed',
      );
    });
    await resolvePendingAiChatResponse({
      accountId,
      pending,
      pendingRequests,
      payload: payloadForUsage,
      finalText,
      assistantMessages,
      finalMetadata,
    });
  } catch (error) {
    // The reliable outbox retains this result for retry. Keep the request and
    // session ownership until the durable delivery transaction commits.
    logger.error(
      { requestId: payload.requestId, err: error },
      'AI Chat result delivery failed; retaining pending request for retry',
    );
    throw error;
  }
}

/**
 * 处理 AI Chat 中间消息。
 * - 不发微信
 * - 直接落库到 session
 */
async function processAiChatMessage(
  payload: SendMessageIpcPayload,
  fallbackAccountId: string | undefined,
  pendingRequests: Map<string, PendingInboxRequest>,
): Promise<void> {
  const accountId = await resolveAccountId(
    payload.accountId,
    fallbackAccountId,
  );
  if (!accountId) {
    throw new Error('无法为 AI Chat 中间消息解析 accountId');
  }

  const text = payload.text?.trim();
  if (!text) {
    throw new Error('AI Chat 中间消息内容为空');
  }

  const pending = payload.requestId
    ? pendingRequests.get(payload.requestId)
    : undefined;

  if (!pending?.sessionId) {
    logger.warn(
      { accountId, requestId: payload.requestId },
      'AI Chat: 中间消息缺 sessionId，丢弃',
    );
    return;
  }
  const streamEvent = streamEventFromMessagePayload({
    payload,
    accountId,
    sessionId: pending.sessionId,
  });

  const ownerUserId = await resolveOwnerUserId({ accountId, pending });
  const msgId = payload.eventId
    ? `aichat-interm-${createHash('sha256')
        .update(accountId)
        .update('\0')
        .update(payload.requestId ?? '')
        .update('\0')
        .update(payload.eventId)
        .digest('hex')}`
    : `aichat-interm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await storeMessage({
    id: msgId,
    account_id: accountId,
    user_id: ownerUserId,
    sender: accountId,
    sender_name: WEB_CHAT_ASSISTANT_NAME,
    content: appendIntermediateMarker(text),
    timestamp: payload.timestamp || new Date().toISOString(),
    is_from_me: true,
    is_bot_message: true,
    session_id: pending.sessionId,
    tool_context:
      payload.skillContext && payload.skillContext.length > 0
        ? JSON.stringify(payload.skillContext)
        : null,
    metadata: payload.metadata,
  });
  if (streamEvent)
    await publishAiChatStreamEvent({
      sessionId: pending.sessionId,
      event: streamEvent,
    });

  logger.info(
    {
      accountId,
      requestId: payload.requestId,
      sessionId: pending.sessionId,
      textPreview: text.slice(0, 80),
    },
    'AI Chat: 中间消息已落库（不发微信）',
  );
}

/**
 * 处理 AI Chat 进度消息。
 * 落库到 session，前端轮询后按 metadata.stage 更新进度标签。
 */
async function processAiChatProgress(
  payload: ProgressIpcPayload,
  fallbackAccountId: string | undefined,
  pendingRequests: Map<string, PendingInboxRequest>,
): Promise<void> {
  const accountId = await resolveAccountId(
    payload.accountId,
    fallbackAccountId,
  );
  if (!accountId) {
    throw new Error('无法为 AI Chat 进度消息解析 accountId');
  }

  const pending = payload.requestId
    ? pendingRequests.get(payload.requestId)
    : undefined;

  if (!pending?.sessionId) {
    logger.warn(
      { accountId, requestId: payload.requestId },
      'AI Chat: 进度消息缺 sessionId，丢弃',
    );
    return;
  }

  const stage = (payload.metadata as Record<string, unknown>)?.stage;
  const metadata =
    payload.metadata && typeof payload.metadata === 'object'
      ? payload.metadata
      : {};
  const kind =
    typeof (metadata as { kind?: unknown }).kind === 'string'
      ? (metadata as { kind: string }).kind
      : 'progress';
  const text = payload.text?.trim() || '处理中';

  const ownerUserId = await resolveOwnerUserId({ accountId, pending });
  await storeMessage({
    id: buildProgressMessageId(payload),
    account_id: accountId,
    user_id: ownerUserId,
    sender: accountId,
    sender_name: WEB_CHAT_ASSISTANT_NAME,
    content: text,
    timestamp: payload.timestamp || new Date().toISOString(),
    is_from_me: true,
    is_bot_message: true,
    session_id: pending.sessionId,
    metadata: {
      ...metadata,
      kind,
      stage,
    },
  });
  await publishAiChatStreamEvent({
    sessionId: pending.sessionId,
    event: streamEventFromProgressPayload({
      payload,
      accountId,
      sessionId: pending.sessionId,
    }),
  });

  logger.info(
    {
      accountId,
      requestId: payload.requestId,
      sessionId: pending.sessionId,
      stage,
      textPreview: text.slice(0, 80),
    },
    'AI Chat: 进度消息已落库',
  );
}
