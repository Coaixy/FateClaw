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
} from '../infrastructure/db.js';
import { incrementDailyTokens } from '../infrastructure/daily-usage.js';
import { getRedis } from '../infrastructure/redis.js';
import {
  PendingInboxRequest,
  ProgressIpcPayload,
  ResponseIpcPayload,
  SendMessageIpcPayload,
  resolveAccountId,
  validateMessagePayload,
  validateProgressPayload,
  validateResponsePayload,
} from './ipc-payloads.js';
import { logger } from '../infrastructure/logger.js';
import {
  recordConversationLogFailure,
  recordConversationLogSuccess,
} from '../shared/conversation-log-metrics.js';
import { mapInternalErrorToPublicError } from '../shared/public-error.js';
import {
  releaseBillingReservation,
  settleBillingReservation,
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

function resolveAiChatResponseText(payload: ResponseIpcPayload): string {
  return (
    payload.publicErrorText ||
    payload.text ||
    (payload.status === 'error'
      ? mapInternalErrorToPublicError(payload.error, {}).publicMessage
      : '')
  ).trim();
}

function buildFinalMetadata(
  payload: ResponseIpcPayload,
): Record<string, unknown> {
  return {
    ...(payload.metadata &&
    typeof payload.metadata === 'object' &&
    !Array.isArray(payload.metadata)
      ? payload.metadata
      : {}),
    kind: 'final',
    turn_complete: true,
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
  const usage = args.payload.usage;
  if (!usage || (!usage.promptTokens && !usage.completionTokens)) return;

  const ownerUserId = await resolveOwnerUserId({
    accountId: args.accountId,
    pending: args.pending,
  });
  if (!ownerUserId) return;

  const today = new Date().toISOString().slice(0, 10);
  await incrementDailyTokens(
    ownerUserId,
    today,
    usage.promptTokens ?? 0,
    usage.completionTokens ?? 0,
  );
  logger.info(
    {
      accountId: args.accountId,
      requestId: args.payload.requestId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    },
    'AI Chat: 已记录 API 真实 token 用量',
  );
}

async function settleAiChatBilling(args: {
  accountId: string;
  pending?: PendingInboxRequest;
  payload: ResponseIpcPayload;
}): Promise<boolean> {
  if (!args.payload.requestId) return false;
  if (args.pending?.llmRuntime?.billingMode !== 'metered') return false;

  const actualChargePoints = await settleBillingReservation({
    requestId: args.payload.requestId,
    runtime: args.pending.llmRuntime,
    promptTokens: args.payload.usage?.promptTokens ?? 0,
    completionTokens: args.payload.usage?.completionTokens ?? 0,
  });
  logger.info(
    {
      accountId: args.accountId,
      requestId: args.payload.requestId,
      actualChargePoints,
    },
    'AI Chat: 已完成超额预扣结算',
  );
  return true;
}

async function resolvePendingAiChatResponse(args: {
  accountId: string;
  pending?: PendingInboxRequest;
  pendingRequests: Map<string, PendingInboxRequest>;
  payload: ResponseIpcPayload;
  finalText: string;
  finalMetadata: Record<string, unknown>;
}): Promise<void> {
  if (!args.pending) return;

  clearTimeout(args.pending.timeout);
  args.pendingRequests.delete(args.payload.requestId!);
  if (args.pending.sessionId) {
    await getRedis()
      .del(`session:processing:${args.pending.sessionId}`)
      .catch(() => {});
  }
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
}): Promise<string | null> {
  if (args.pending?.ownerUserId) {
    return args.pending.ownerUserId;
  }
  const webUserId = getUserIdFromWebChatRuntimeId(args.accountId);
  if (!webUserId) {
    return null;
  }
  const user = await getUserById(webUserId);
  return user?.id ?? null;
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
  let reservationSettled = false;

  try {
    const accountId = await resolveAccountId(
      payload.accountId,
      fallbackAccountId,
    );
    if (!accountId) {
      throw new Error('无法为 AI Chat response 解析 accountId');
    }

    const text = resolveAiChatResponseText(payload);
    if (!text && payload.status === 'error') {
      throw new Error('AI Chat response 文本为空');
    }

    const finalText = text ? appendFinalTurnMarker(text, payload.usage) : '';
    const finalMetadata = buildFinalMetadata(payload);

    logger.info(
      {
        accountId,
        requestId: payload.requestId,
        status: payload.status,
        sessionId: pending?.sessionId,
      },
      'AI Chat: 处理最终响应（不发微信）',
    );

    // 注意：最终响应的落库由 chat-sessions.ts 负责，这里不重复存储
    // 只处理 conversation log、token 用量、billing 结算

    storeAiChatConversationLog({ accountId, payload });
    await recordAiChatTokenUsage({ accountId, pending, payload });
    reservationSettled = await settleAiChatBilling({
      accountId,
      pending,
      payload,
    });
    await resolvePendingAiChatResponse({
      accountId,
      pending,
      pendingRequests,
      payload,
      finalText,
      finalMetadata,
    });
  } catch (error) {
    if (pending?.billingReservation && !reservationSettled) {
      try {
        await releaseBillingReservation(
          pending.billingReservation,
          'AI Chat 响应异常，释放预扣额度',
        );
      } catch (releaseErr) {
        logger.error(
          { requestId: payload.requestId, err: releaseErr },
          'AI Chat: 响应异常后释放预扣额度失败',
        );
      }
    }
    // 即使处理失败也必须 resolve pending
    if (pending) {
      clearTimeout(pending.timeout);
      pendingRequests.delete(payload.requestId!);
      if (pending.sessionId) {
        await getRedis()
          .del(`session:processing:${pending.sessionId}`)
          .catch(() => {});
      }
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
          kind: 'final',
          turn_complete: true,
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

  const stage = (payload.metadata as Record<string, unknown>)?.stage;
  const text = payload.text?.trim() || '处理中';

  const ownerUserId = await resolveOwnerUserId({ accountId, pending });
  const msgId = `aichat-progress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await storeMessage({
    id: msgId,
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
      kind: 'progress',
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
