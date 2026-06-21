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
  storeConversationLog,
  storeMessage,
  touchChatSession,
} from '../infrastructure/db.js';
import {
  incrementDailyMessageCount,
  incrementDailyTokens,
} from '../infrastructure/daily-usage.js';
import {
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
import { logger } from '../infrastructure/logger.js';
import {
  publishAiChatStreamEvent,
  streamEventFromMessagePayload,
  streamEventFromProgressPayload,
  streamEventFromResponsePayload,
} from './ai-chat-stream.js';
import {
  recordConversationLogFailure,
  recordConversationLogSuccess,
} from '../shared/conversation-log-metrics.js';
import { mapInternalErrorToPublicError } from '../shared/public-error.js';
import {
  settleBillingReservationDetailed,
  type BillingSettlementSummary,
} from '../modules/billing/plans.js';
import {
  getUserIdFromWebChatRuntimeId,
  WEB_CHAT_ASSISTANT_NAME,
} from '../modules/chat/web-chat-runtime.js';

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
  if (!pending?.localAgentLeaseAccountId) return;
  await releaseLocalAgent(pending.localAgentLeaseAccountId).catch((err) => {
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

function storeAiChatConversationLog(args: {
  accountId: string;
  payload: ResponseIpcPayload;
}): void {
  const hasTranscript = (args.payload.transcript?.length ?? 0) > 0;
  const hasTraceEvents = (args.payload.traceEvents?.length ?? 0) > 0;
  if (!args.payload.requestId || (!hasTranscript && !hasTraceEvents)) return;

  const logId = `clog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  storeConversationLog({
    id: logId,
    accountId: args.accountId,
    requestId: args.payload.requestId,
    transcript: args.payload.transcript ?? [],
    usage: args.payload.usage,
    model: args.payload.model,
    provider: args.payload.provider,
    traceEvents: args.payload.traceEvents,
    piSession: args.payload.piSession,
    agentGraph: args.payload.agentGraph,
  }).then(
    () => recordConversationLogSuccess(),
    (err) =>
      recordConversationLogFailure(
        { accountId: args.accountId, requestId: args.payload.requestId },
        err,
      ),
  );
}

async function recordAiChatTokenUsage(args: {
  accountId: string;
  pending?: PendingInboxRequest;
  payload: ResponseIpcPayload;
}): Promise<void> {
  const normalizedUsage = normalizeRuntimeTokenUsage(args.payload.usage);
  if (normalizedUsage.totalTokens <= 0) return;

  const ownerUserId = await resolveOwnerUserId({
    accountId: args.accountId,
    pending: args.pending,
    payloadOwnerUserId: args.payload.ownerUserId,
  });
  if (!ownerUserId) return;

  const today = new Date().toISOString().slice(0, 10);
  await incrementDailyTokens(
    ownerUserId,
    today,
    normalizedUsage.promptTokens,
    normalizedUsage.completionTokens,
    normalizedUsage.totalTokens,
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
  if (args.pending?.llmRuntime?.billingMode !== 'metered') return null;
  const normalizedUsage = normalizeRuntimeTokenUsage(args.payload.usage);

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
    skillContext: args.payload.skillContext,
  });
}

async function resolveOwnerUserId(args: {
  accountId: string;
  pending?: PendingInboxRequest;
  payloadOwnerUserId?: string;
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
): Promise<void> {
  if (!ownerUserId) return;
  const today = new Date().toISOString().slice(0, 10);
  await incrementDailyMessageCount(ownerUserId, today);
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

async function storeAiChatFinalResponseMessages(args: {
  accountId: string;
  pending?: PendingInboxRequest;
  payload: ResponseIpcPayload;
  responseText: string;
  assistantMessages: string[];
  finalMetadata: Record<string, unknown>;
}): Promise<void> {
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
    return;
  }

  const ownerUserId = await resolveOwnerUserId({
    accountId: args.accountId,
    pending: args.pending,
    payloadOwnerUserId: args.payload.ownerUserId,
  });

  if (args.payload.status === 'error') {
    const content =
      args.responseText.trim() ||
      args.payload.publicErrorText?.trim() ||
      mapInternalErrorToPublicError(args.payload.error, {}).publicMessage;
    await storeMessage({
      id: `${userMessageId}_error`,
      account_id: args.accountId,
      user_id: ownerUserId,
      sender: args.accountId,
      sender_name: WEB_CHAT_ASSISTANT_NAME,
      content,
      timestamp: args.payload.timestamp || new Date().toISOString(),
      is_from_me: true,
      is_bot_message: true,
      session_id: sessionId,
      // workflow AI 节点失败:把节点 id 落列,供编排器 reconcile 检测到失败并置节点 error。
      workflow_node_id: args.pending?.workflowNodeId ?? null,
      metadata: {
        ...args.finalMetadata,
        kind: 'error',
        turn_complete: true,
        request_id: args.payload.requestId,
      },
    });
    await touchChatSession(sessionId);
    return;
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
    await touchChatSession(sessionId);
    await incrementAiChatDailyMessageCount(ownerUserId);
    return;
  }

  const replyTimestampBase = Date.now();
  for (let index = 0; index < args.assistantMessages.length; index += 1) {
    const isFinalReply = index === args.assistantMessages.length - 1;
    await storeMessage({
      id:
        args.assistantMessages.length === 1
          ? `${userMessageId}_reply`
          : `${userMessageId}_reply_${index + 1}`,
      account_id: args.accountId,
      user_id: ownerUserId,
      sender: args.accountId,
      sender_name: WEB_CHAT_ASSISTANT_NAME,
      content: args.assistantMessages[index],
      timestamp: new Date(replyTimestampBase + index).toISOString(),
      is_from_me: true,
      is_bot_message: true,
      session_id: sessionId,
      tool_context:
        isFinalReply &&
        args.payload.skillContext &&
        args.payload.skillContext.length > 0
          ? JSON.stringify(args.payload.skillContext)
          : null,
      metadata: isFinalReply
        ? args.finalMetadata
        : {
            kind: 'assistant',
            request_id: args.payload.requestId,
          },
      // workflow AI 节点产出:把节点 id 落入 workflow_node_id 列,实现"节点↔产出"结构化关联
      // (替代靠回复 id `wf-<nodeId>-…_reply` 反解)。仅单段 `_reply` 落列,与 collectNodeOutputs
      // 读口径一致(多段 `_reply_N` 维持既有"不收集"行为);非 workflow 请求 pending 无该字段 → 列为空。
      workflow_node_id:
        args.assistantMessages.length === 1
          ? (args.pending?.workflowNodeId ?? null)
          : null,
    });
  }

  await touchChatSession(sessionId);
  await incrementAiChatDailyMessageCount(ownerUserId);
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

  return `aichat-progress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    await processAiChatResponse(payload, fallbackAccountId, pendingRequests);
    return;
  }
  if (validateMessagePayload(payload)) {
    await processAiChatMessage(payload, fallbackAccountId, pendingRequests);
    return;
  }
  if (validateProgressPayload(payload)) {
    await processAiChatProgress(payload, fallbackAccountId, pendingRequests);
    return;
  }
  throw new Error('无效的 AI Chat outbox IPC 消息格式');
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

    storeAiChatConversationLog({ accountId, payload: payloadForUsage });
    await recordAiChatTokenUsage({
      accountId,
      pending,
      payload: payloadForUsage,
    });
    const billing = await settleAiChatBilling({
      accountId,
      pending,
      payload: payloadForUsage,
    });
    const finalMetadata = buildFinalMetadata({
      payload: payloadForUsage,
      durationMs,
      billing,
    });

    await storeAiChatFinalResponseMessages({
      accountId,
      pending,
      payload: payloadForUsage,
      responseText: text,
      assistantMessages,
      finalMetadata,
    });
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
    await releaseCompletedAiChatSessionLock({
      pending,
      payload,
      sessionId: resolveAiChatFinalSessionId(pending, payload),
    });
    // 即使处理失败也必须 resolve pending
    if (pending) {
      clearTimeout(pending.timeout);
      pendingRequests.delete(payload.requestId!);
      if (pending.sessionId) {
        await releaseSessionProcessingLock(
          pending.sessionId,
          pending.sessionProcessingRequestId ?? payload.requestId,
        ).catch(() => {});
      }
      await releaseLocalAgentLeaseForPending(pending, {
        accountId: pending.accountId,
        requestId: payload.requestId,
        reason: 'ai_chat_response_error',
      });
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        { requestId: payload.requestId, err: error },
        'AI Chat: 处理 response 失败，resolve pending 为 error',
      );
      const publicError = mapInternalErrorToPublicError(errorMsg);
      pending.resolve({
        requestId: payload.requestId!,
        status: 'error',
        text: publicError.publicMessage,
        error: errorMsg,
        publicErrorText: publicError.publicMessage,
        publicReasonCode: publicError.publicReasonCode,
        metadata: {
          ...buildFinalMetadata({
            payload,
            durationMs: resolvePendingDurationMs(pending),
          }),
        },
      });
    }
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
  if (streamEvent) {
    await publishAiChatStreamEvent({
      sessionId: pending.sessionId,
      event: streamEvent,
    });
  }

  const ownerUserId = await resolveOwnerUserId({ accountId, pending });
  const msgId = `aichat-interm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  await publishAiChatStreamEvent({
    sessionId: pending.sessionId,
    event: streamEventFromProgressPayload({
      payload,
      accountId,
      sessionId: pending.sessionId,
    }),
  });

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
