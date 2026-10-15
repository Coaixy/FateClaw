/**
 * IPC outbox 队列处理：出站消息投递、响应完成、token 追踪。
 */

import {
  getAccount,
  getUserByAccountId,
  storeConversationLog,
  storeMessage,
} from '../infrastructure/db.js';
import { incrementDailyTokens } from '../infrastructure/daily-usage.js';
import { sendMessage as ilinkSendMessage } from '../infrastructure/ilink.js';
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
  recordConversationLogFailure,
  recordConversationLogSuccess,
} from '../shared/conversation-log-metrics.js';
import { mapInternalErrorToPublicError } from '../shared/public-error.js';
import { settleBillingReservation } from '../modules/billing/plans.js';
import { estimateTokens } from '../shared/token-budget.js';

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

async function deliverOutboundMessage(
  args: {
    accountId: string;
    text: string;
    timestamp?: string;
    requestId?: string;
    fallbackUserId?: string;
    fallbackContextToken?: string;
    skipTokenTracking?: boolean;
    metadata?: unknown;
    /** Skill 执行结果，存入消息的 tool_context 字段。 */
    skillContext?: Array<{
      skill: string;
      output: string;
      artifactType?: string;
      artifactTitle?: string;
      artifactData?: unknown;
    }>;
  },
  pendingRequests: Map<string, PendingInboxRequest>,
): Promise<void> {
  const account = await getAccount(args.accountId);
  if (!account) {
    throw new Error(`消息请求对应账号不存在: ${args.accountId}`);
  }

  const pending = args.requestId
    ? pendingRequests.get(args.requestId)
    : undefined;
  const toUserId = pending?.toUserId || args.fallbackUserId || account.user_id;
  const contextToken = pending?.contextToken || args.fallbackContextToken;

  logger.info(
    {
      accountId: args.accountId,
      requestId: args.requestId,
      toUserId,
      hasContextToken: Boolean(contextToken),
      textPreview: args.text.slice(0, 80),
    },
    '通过 iLink 发送出站消息',
  );

  const clientId = await ilinkSendMessage(
    {
      id: account.id,
      bot_token: account.bot_token,
      base_url: account.base_url,
    },
    toUserId,
    args.text,
    contextToken,
  );

  await storeMessage({
    id: clientId,
    account_id: account.id,
    sender: account.id,
    sender_name: account.name,
    content: args.text,
    timestamp: args.timestamp || new Date().toISOString(),
    is_from_me: true,
    is_bot_message: true,
    tool_context:
      args.skillContext && args.skillContext.length > 0
        ? JSON.stringify(args.skillContext)
        : null,
    metadata: args.metadata,
  });

  // 追踪 output tokens（仅在调用方未自行处理时使用估算值兜底）
  if (!args.skipTokenTracking) {
    const owner = await getUserByAccountId(args.accountId);
    if (owner) {
      const today = new Date().toISOString().slice(0, 10);
      const outputTokens = estimateTokens(args.text);
      if (outputTokens > 0) {
        await incrementDailyTokens(owner.id, today, 0, outputTokens);
      }
    }
  }

  logger.info(
    { accountId: args.accountId, requestId: args.requestId, clientId },
    '出站消息已发送并存储',
  );
}

async function processOutboxResponse(
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
      throw new Error('无法为 response 请求解析 accountId');
    }

    const text = (
      payload.publicErrorText ||
      payload.text ||
      (payload.status === 'error'
        ? mapInternalErrorToPublicError(payload.error, {}).publicMessage
        : '')
    )?.trim();
    if (!text) {
      throw new Error('response 文本为空');
    }
    const normalizedPayloadUsage = normalizeRuntimeTokenUsage(payload.usage);
    const hasRealUsage = normalizedPayloadUsage.totalTokens > 0;
    const payloadForUsage = hasRealUsage
      ? { ...payload, usage: normalizedPayloadUsage }
      : payload;
    const finalText = appendFinalTurnMarker(text, payloadForUsage.usage);
    const finalMetadata = {
      ...(payload.metadata &&
      typeof payload.metadata === 'object' &&
      !Array.isArray(payload.metadata)
        ? payload.metadata
        : {}),
      kind: 'final',
      turn_complete: true,
    };

    if (pending?.autoDeliver ?? true) {
      logger.info(
        {
          accountId,
          requestId: payload.requestId,
          status: payload.status,
          autoDeliver: pending?.autoDeliver ?? true,
        },
        '正在处理发件箱中的常驻响应',
      );
      await deliverOutboundMessage(
        {
          accountId,
          text: finalText,
          timestamp: payload.timestamp,
          requestId: payload.requestId,
          skipTokenTracking: Boolean(hasRealUsage),
          skillContext: payload.skillContext,
          metadata: finalMetadata,
        },
        pendingRequests,
      );
    }

    // 异步存储 conversation log（不阻塞响应流程）
    // 落库条件放宽：transcript 或 traceEvents 任一非空即落库，
    // 让"早期出错导致 transcript 为空但已有 trace 事件"的请求也能被 admin 查到。
    const hasTranscript = (payload.transcript?.length ?? 0) > 0;
    const hasTraceEvents = (payload.traceEvents?.length ?? 0) > 0;
    if (payload.requestId && (hasTranscript || hasTraceEvents)) {
      const logId = `clog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      storeConversationLog({
        id: logId,
        accountId,
        requestId: payload.requestId,
        transcript: payload.transcript ?? [],
        usage: payloadForUsage.usage,
        model: payload.model,
        provider: payload.provider,
        traceEvents: payload.traceEvents,
        piSession: payload.piSession,
        agentGraph: payload.agentGraph,
      }).then(
        () => recordConversationLogSuccess(),
        (err) =>
          recordConversationLogFailure(
            { accountId, requestId: payload.requestId },
            err,
          ),
      );
    }

    // 使用 API 返回的真实 token 用量
    if (hasRealUsage) {
      const owner = await getUserByAccountId(accountId);
      if (owner) {
        const today = new Date().toISOString().slice(0, 10);
        await incrementDailyTokens(
          owner.id,
          today,
          normalizedPayloadUsage.promptTokens,
          normalizedPayloadUsage.completionTokens,
          normalizedPayloadUsage.totalTokens,
        );
        logger.info(
          {
            accountId,
            requestId: payload.requestId,
            promptTokens: normalizedPayloadUsage.promptTokens,
            completionTokens: normalizedPayloadUsage.completionTokens,
            totalTokens: normalizedPayloadUsage.totalTokens,
          },
          '已记录 API 真实 token 用量',
        );
      }
    }

    if (payload.requestId && pending?.llmRuntime?.billingMode === 'metered') {
      const actualChargeCoins = await settleBillingReservation({
        requestId: payload.requestId,
        runtime: pending.llmRuntime,
        promptTokens: normalizedPayloadUsage.promptTokens,
        completionTokens: normalizedPayloadUsage.completionTokens,
      });
      logger.info(
        {
          accountId,
          requestId: payload.requestId,
          actualChargeCoins,
        },
        '已完成模型 Token 扣费结算',
      );
    }

    if (pending) {
      clearTimeout(pending.timeout);
      pendingRequests.delete(payload.requestId!);
      // 清除会话忙碌标记
      if (pending.sessionId) {
        await releaseSessionProcessingLock(
          pending.sessionId,
          pending.sessionProcessingRequestId ?? payload.requestId,
        ).catch(() => {});
      }
      await releaseLocalAgentLeaseForPending(pending, {
        accountId,
        requestId: payload.requestId,
        reason: 'response',
      });
      logger.info(
        {
          accountId,
          requestId: payload.requestId,
          status: payload.status || 'success',
        },
        '收件箱请求已从常驻响应中完成',
      );
      pending.resolve({
        requestId: payload.requestId!,
        status: payload.status || 'success',
        text: finalText,
        error: payload.error,
        publicErrorText: payload.publicErrorText,
        publicReasonCode: payload.publicReasonCode,
        metadata: finalMetadata,
        skillContext: payload.skillContext,
      });
    }
  } catch (error) {
    // 即使投递失败也必须 resolve pending，否则 submitInboxRequest 会挂起直到 30 分钟超时
    if (pending) {
      clearTimeout(pending.timeout);
      pendingRequests.delete(payload.requestId!);
      // 清除会话忙碌标记
      if (pending.sessionId) {
        await releaseSessionProcessingLock(
          pending.sessionId,
          pending.sessionProcessingRequestId ?? payload.requestId,
        ).catch(() => {});
      }
      await releaseLocalAgentLeaseForPending(pending, {
        accountId: pending.accountId,
        requestId: payload.requestId,
        reason: 'response_error',
      });
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        { requestId: payload.requestId, err: error },
        '处理 response 失败，resolve pending 为 error 以避免请求挂起',
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
    throw error; // 继续向上抛出以便调用方记录日志
  }
}

async function processOutboxMessage(
  payload: SendMessageIpcPayload,
  fallbackAccountId: string | undefined,
  pendingRequests: Map<string, PendingInboxRequest>,
): Promise<void> {
  const accountId = await resolveAccountId(
    payload.accountId,
    fallbackAccountId,
  );
  if (!accountId) {
    throw new Error('无法为消息请求解析 accountId');
  }

  const text = payload.text?.trim();
  if (!text) {
    throw new Error('outbox 消息内容为空');
  }

  const pending = payload.requestId
    ? pendingRequests.get(payload.requestId)
    : undefined;

  // autoDeliver=false 的请求（web ai-chat）不推送到微信，
  // 而是把中间消息落库到对应 chat_session，前端 reload 后可见。
  if (pending && !pending.autoDeliver) {
    if (!pending.sessionId) {
      logger.warn(
        { accountId, requestId: payload.requestId },
        'autoDeliver=false 但缺 sessionId，丢弃中间消息',
      );
      return;
    }

    const account = await getAccount(accountId);
    if (!account) {
      throw new Error(`中间消息对应账号不存在: ${accountId}`);
    }

    const msgId = `aichat-interm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await storeMessage({
      id: msgId,
      account_id: account.id,
      sender: account.id,
      sender_name: account.name,
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
      'AI 对话: 中间消息已落库（不推送微信）',
    );
    return;
  }

  await deliverOutboundMessage(
    {
      accountId,
      text,
      timestamp: payload.timestamp,
      requestId: payload.requestId,
      metadata: payload.metadata,
      skillContext: payload.skillContext,
    },
    pendingRequests,
  );

  logger.info(
    { accountId, requestId: payload.requestId },
    '已处理直接发件箱消息',
  );
}

async function processOutboxProgress(
  payload: ProgressIpcPayload,
  fallbackAccountId: string | undefined,
  pendingRequests: Map<string, PendingInboxRequest>,
): Promise<void> {
  const accountId = await resolveAccountId(
    payload.accountId,
    fallbackAccountId,
  );
  if (!accountId) {
    throw new Error('无法为进度请求解析 accountId');
  }

  const text = payload.text?.trim();
  if (!text) {
    throw new Error('outbox 进度内容为空');
  }

  const pending = payload.requestId
    ? pendingRequests.get(payload.requestId)
    : undefined;

  if (pending && !pending.autoDeliver) {
    if (!pending.sessionId) {
      logger.warn(
        { accountId, requestId: payload.requestId },
        'autoDeliver=false 但缺 sessionId，丢弃进度消息',
      );
      return;
    }

    const account = await getAccount(accountId);
    if (!account) {
      throw new Error(`进度消息对应账号不存在: ${accountId}`);
    }

    const msgId = `aichat-progress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await storeMessage({
      id: msgId,
      account_id: account.id,
      sender: account.id,
      sender_name: account.name,
      content: text,
      timestamp: payload.timestamp || new Date().toISOString(),
      is_from_me: true,
      is_bot_message: true,
      session_id: pending.sessionId,
      metadata: {
        kind: 'progress',
        ...(payload.metadata ?? {}),
      },
    });

    logger.info(
      {
        accountId,
        requestId: payload.requestId,
        sessionId: pending.sessionId,
        textPreview: text.slice(0, 80),
      },
      'AI 对话: 进度消息已落库',
    );
    return;
  }

  logger.debug(
    { accountId, requestId: payload.requestId, textPreview: text.slice(0, 80) },
    '进度消息已忽略（当前仅 web ai-chat 持久化展示）',
  );
}

export async function processOutboxPayload(
  payload: unknown,
  fallbackAccountId: string | undefined,
  pendingRequests: Map<string, PendingInboxRequest>,
): Promise<void> {
  if (validateResponsePayload(payload)) {
    await processOutboxResponse(payload, fallbackAccountId, pendingRequests);
    return;
  }

  if (validateMessagePayload(payload)) {
    await processOutboxMessage(payload, fallbackAccountId, pendingRequests);
    return;
  }

  if (validateProgressPayload(payload)) {
    await processOutboxProgress(payload, fallbackAccountId, pendingRequests);
    return;
  }

  throw new Error('无效的 outbox IPC 消息格式');
}
