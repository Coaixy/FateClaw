import {
  claimDurableExecution,
  deliverDurableResult,
  startDurableExecutionHeartbeat,
} from './durable-execution.js';
import { encodeAgentIpc } from './ipc-security.js';
import { log } from './io.js';
import { getRedis } from './redis.js';
import { executeContainerInput } from './request-boundary.js';
import {
  createRequestScope,
  getLastRequestActivityAt,
  listScopedTraceEvents,
  setRequestId,
  type RequestScope,
} from './request-scope.js';
import type {
  InboxRequest,
  LlmRuntimeSnapshot,
  OutboxResponse,
} from './types.js';
import type { SessionControls } from './inbox-cancellation.js';

export interface InboxRequestState {
  activeSessions: Map<string, SessionControls>;
  pendingCancelRequests: Map<string, number>;
  activeRequests: Map<string, { request: InboxRequest; scope: RequestScope }>;
}

// 无进展 watchdog：Pi 每次流式 delta、回合切换、工具事件都会刷新活动时间。
// 连续超过该时长没有任何事件，才判定 Provider/工具 await 真正卡住；不再把正常推进的
// 多技能长任务按「请求总时长」误杀。
const AGENT_REQUEST_STALL_TIMEOUT_MS = Math.max(
  60_000,
  Math.trunc(Number(process.env.AGENT_RUNTIME_REQUEST_TIMEOUT_MS ?? '')) ||
    8 * 60 * 1000,
);
// 活跃但失控的无限循环仍需绝对上限。默认 25 分钟，小于宿主 API 的 30 分钟兜底，
// 为 abort、写 outbox、落库和释放锁预留 5 分钟。宿主通过 agent-env.ts 注入同一事实源。
const AGENT_REQUEST_MAX_DURATION_MS = Math.max(
  AGENT_REQUEST_STALL_TIMEOUT_MS + 60_000,
  Math.trunc(Number(process.env.AGENT_RUNTIME_REQUEST_MAX_DURATION_MS ?? '')) ||
    25 * 60 * 1000,
);
const WATCHDOG_CHECK_INTERVAL_MS = Math.min(
  1_000,
  Math.max(100, Math.floor(AGENT_REQUEST_STALL_TIMEOUT_MS / 4)),
);

type RequestWatchdogResult = 'stall_timeout' | 'max_duration';

class AgentRequestTimeoutError extends Error {
  readonly publicErrorText = '这次处理超时了，请稍后再试。';
  readonly publicReasonCode = 'agent_timeout' as const;
}

/**
 * 创建请求 watchdog：区分「连续无进展」和「活跃但总时长失控」。
 *
 * @param scope 请求级活动时间与 trace 缓冲。
 * @param startedAtMs 请求开始时间。
 * @returns 可参与 Promise.race 的结果，以及结束后必须调用的 stop 清理函数。
 */
function createRequestWatchdog(
  scope: RequestScope,
  startedAtMs = Date.now(),
): { promise: Promise<RequestWatchdogResult>; stop: () => void } {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const promise = new Promise<RequestWatchdogResult>((resolve) => {
    const check = () => {
      if (stopped) return;
      const now = Date.now();
      if (now - startedAtMs >= AGENT_REQUEST_MAX_DURATION_MS) {
        stopped = true;
        resolve('max_duration');
        return;
      }
      if (
        now - getLastRequestActivityAt(scope) >=
        AGENT_REQUEST_STALL_TIMEOUT_MS
      ) {
        stopped = true;
        resolve('stall_timeout');
        return;
      }
      timer = setTimeout(check, WATCHDOG_CHECK_INTERVAL_MS);
    };
    timer = setTimeout(check, WATCHDOG_CHECK_INTERVAL_MS);
  });

  return {
    promise,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

function isLlmRuntimeSnapshot(value: unknown): value is LlmRuntimeSnapshot {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<LlmRuntimeSnapshot>;
  return (
    (record.piApi === 'openai-completions' ||
      record.piApi === 'openai-responses' ||
      record.piApi === 'anthropic-messages' ||
      record.piApi === 'google-generative-ai') &&
    (record.source === 'custom' || record.source === 'official') &&
    (record.billingMode === 'none' || record.billingMode === 'metered') &&
    typeof record.modelConfigId === 'string' &&
    record.modelConfigId.trim().length > 0 &&
    typeof record.model === 'string' &&
    record.model.trim().length > 0 &&
    (record.contextWindowTokens === undefined ||
      (typeof record.contextWindowTokens === 'number' &&
        Number.isInteger(record.contextWindowTokens) &&
        record.contextWindowTokens > 0)) &&
    (record.maxOutputTokens === undefined ||
      (typeof record.maxOutputTokens === 'number' &&
        Number.isInteger(record.maxOutputTokens) &&
        record.maxOutputTokens > 0)) &&
    (record.thinkingLevel === undefined ||
      record.thinkingLevel === 'off' ||
      record.thinkingLevel === 'minimal' ||
      record.thinkingLevel === 'low' ||
      record.thinkingLevel === 'medium' ||
      record.thinkingLevel === 'high' ||
      record.thinkingLevel === 'xhigh') &&
    typeof record.apiKey === 'string' &&
    record.apiKey.trim().length > 0 &&
    typeof record.providerKey === 'string' &&
    record.providerKey.trim().length > 0 &&
    (record.authMode === 'openai_api_key' ||
      record.authMode === 'anthropic_api_key' ||
      record.authMode === 'claude_code_oauth_token' ||
      record.authMode === 'gemini_api_key') &&
    (record.baseUrl === undefined || typeof record.baseUrl === 'string') &&
    (record.poolNodes === undefined ||
      (record.source === 'official' &&
        Array.isArray(record.poolNodes) &&
        record.poolNodes.length > 0 &&
        record.poolNodes.length <= 20 &&
        new Set(record.poolNodes.map((node) => node?.modelConfigId)).size ===
          record.poolNodes.length &&
        record.poolNodes.every(
          (node) =>
            node &&
            Number.isInteger(node.weight) &&
            node.weight >= 1 &&
            node.weight <= 1000 &&
            Number.isInteger(node.revision) &&
            node.revision > 0 &&
            isLlmRuntimeSnapshot({ ...record, ...node, poolNodes: undefined }),
        )))
  );
}

function parseInboxRequest(raw: string): InboxRequest {
  const parsed = JSON.parse(raw) as Partial<InboxRequest>;

  if (
    (parsed.type !== 'chat' && parsed.type !== 'task') ||
    !parsed.requestId ||
    !parsed.accountId ||
    !parsed.userMessage ||
    !isLlmRuntimeSnapshot(parsed.llmRuntime)
  ) {
    throw new Error('无效的 inbox 请求');
  }

  return parsed as InboxRequest;
}

/**
 * 为一条"进程即将因未捕获异常/rejection 崩溃"的请求，构造推给 outbox 的错误响应。
 *
 * 抽成纯函数是为了能脱离真实 Redis/process.exit 单独测试内容是否正确
 * （error 字段是否带上了详细诊断信息，publicErrorText 是否是用户可读文案）。
 *
 * @param kind 触发崩溃的事件类型。
 * @param detail 异常的详细信息（优先用 stack，没有 stack 则用 message/字符串化结果）。
 * @param request 该请求解析出的原始 inbox 请求，用于取 accountId/sessionId 等字段。
 * @param scope 当前请求已记录的用量。
 * @returns 可直接 JSON 序列化后 lpush 到 outbox 队列的错误响应。
 */
export function buildFatalOutboxResponse(
  kind: 'uncaughtException' | 'unhandledRejection',
  detail: string,
  request: InboxRequest,
  scope?: RequestScope,
): OutboxResponse {
  return {
    type: 'response',
    requestId: request.requestId,
    accountId: request.accountId,
    sessionId: request.sessionId,
    userMessageId: request.userMessageId,
    ownerUserId: request.ownerUserId,
    text: '这次没有完成，原因：处理进程发生了未捕获的异常。',
    status: 'error',
    error: `daemon 进程 ${kind}：${detail}`,
    publicErrorText:
      '这次没有完成，处理进程发生了未预期的错误，请重新发送试试。',
    publicReasonCode: 'daemon_fatal_error',
    timestamp: new Date().toISOString(),
    usage: scope?.partialUsage,
    metadata: {
      kind: 'final',
      turn_complete: true,
      ...(!scope?.partialUsage ? { synthetic_terminal: true } : {}),
    },
  };
}

export function pushEncryptedOutbox(queue: string, payload: string) {
  return getRedis().lpush(queue, encodeAgentIpc(queue, payload));
}

export async function processInboxMessage(
  accountId: string,
  raw: string,
  state: InboxRequestState,
): Promise<void> {
  const { activeSessions, pendingCancelRequests, activeRequests } = state;
  let request: InboxRequest | undefined;
  const requestScope = createRequestScope();
  let stopLease = () => {};
  let ownsExecution = false;
  let generatedResult = false;
  let executionEnded = false;

  try {
    request = parseInboxRequest(raw);

    if (request.accountId !== accountId) {
      throw new Error(
        `inbox 请求账号不匹配: expected=${accountId} actual=${request.accountId}`,
      );
    }

    if (!(await claimDurableExecution(request))) return;
    ownsExecution = true;
    const { requestId } = request;
    stopLease = startDurableExecutionHeartbeat(request, () => {
      const controls = activeSessions.get(requestId);
      if (controls) void controls.abort().catch(() => {});
      else pendingCancelRequests.set(requestId, Date.now());
    });

    // 供 uncaughtException/unhandledRejection 兜底使用：进程崩溃前需要靠这份
    // 上下文（accountId/sessionId/outboxQueue 等）拼出一条错误响应推给宿主，
    // 仅存 activeSessions 的 abort 句柄不够——那里没有这些字段。
    activeRequests.set(requestId, { request, scope: requestScope });

    setRequestId(requestScope, requestId);
    log(
      `正在处理收件箱请求 requestId=${request.requestId} type=${request.type} accountId=${request.accountId}${request.outboxQueue ? ` outboxQueue=${request.outboxQueue}` : ''}`,
    );

    let raced:
      Awaited<ReturnType<typeof executeContainerInput>> | RequestWatchdogResult;
    const watchdog = createRequestWatchdog(requestScope);
    try {
      raced = await Promise.race([
        executeContainerInput(
          {
            accountId,
            executionId: request.executionId,
            sessionId: request.sessionId,
            llmRuntime: request.llmRuntime,
            userMessage: request.userMessage,
            inputKind: request.inputKind,
            pastedBoard: request.pastedBoard,
            sessionBoardContexts: request.sessionBoardContexts,
            piSessionBase: request.piSessionBase,
            acceptedAtMs: request.acceptedAtMs,
            history: request.history ?? [],
            userName: request.userName,
            assistantName: request.assistantName,
            personaPrompt: request.personaPrompt,
            authorizedSkillIds: request.authorizedSkillIds,
            outboxQueue: request.outboxQueue,
          },
          requestScope,
          undefined,
          {
            onSessionReady(sessionControls) {
              if (executionEnded) {
                void sessionControls.abort().catch(() => {});
                return;
              }
              activeSessions.set(requestId, sessionControls);
              if (pendingCancelRequests.delete(requestId)) {
                void sessionControls.abort().catch(() => {});
              }
            },
          },
        ),
        watchdog.promise,
      ]);
    } finally {
      watchdog.stop();
    }

    if (raced === 'stall_timeout' || raced === 'max_duration') {
      executionEnded = true;
      // 放弃等待并尝试 abort 当前 session；若卡死原因是同步阻塞（如灾难性正则回溯），
      // abort 无法真正打断执行，但至少能让本次请求以明确错误结束，不再无限静默。
      void activeSessions
        .get(request.requestId)
        ?.abort()
        .catch(() => {});
      const detail =
        raced === 'stall_timeout'
          ? `请求连续 ${Math.round(AGENT_REQUEST_STALL_TIMEOUT_MS / 1000)}s 无进展，判定处理停滞`
          : `请求总时长超过 ${Math.round(AGENT_REQUEST_MAX_DURATION_MS / 1000)}s`;
      throw new AgentRequestTimeoutError(detail);
    }
    const output = raced;

    const response: OutboxResponse = {
      type: 'response',
      requestId: request.requestId,
      accountId,
      sessionId: request.sessionId,
      userMessageId: request.userMessageId,
      ownerUserId: request.ownerUserId,
      text:
        output.status === 'success'
          ? output.result || ''
          : output.publicErrorText || '抱歉，AI 服务暂时不可用',
      status: output.status,
      error: output.error,
      publicErrorText: output.publicErrorText,
      publicReasonCode: output.publicReasonCode,
      timestamp: new Date().toISOString(),
      usage: output.usage,
      skillContext: output.skillContext,
      transcript: output.transcript,
      model: output.model,
      provider: output.provider,
      traceEvents: output.traceEvents,
      agentGraph: output.agentGraph,
      piSession: output.piSession,
      metadata: {
        kind: 'final',
        turn_complete: true,
      },
    };

    // 写入指定的 outbox 队列（或默认队列）
    const outboxQueue = request.outboxQueue ?? `ipc:${accountId}:outbox`;
    generatedResult = true;
    await deliverDurableResult(request, response, pushEncryptedOutbox);

    log(
      `已完成收件箱请求 requestId=${request.requestId} status=${output.status} outbox=${outboxQueue}`,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`处理收件箱消息失败: ${errorMessage}`);

    // 若已解析出 requestId，推送错误响应，避免宿主机无限等待
    if (
      !generatedResult &&
      request?.requestId &&
      (!request.executionId || ownsExecution)
    ) {
      try {
        // 请求边界之外的异常（例如 watchdog 超时）仍可读取本轮 trace。
        const traceEvents = listScopedTraceEvents(requestScope);
        const timeoutError =
          error instanceof AgentRequestTimeoutError ? error : undefined;
        const publicErrorText =
          timeoutError?.publicErrorText ??
          '这次没有完成，原因：处理收件箱请求失败。';
        const errorResponse: OutboxResponse = {
          type: 'response',
          requestId: request.requestId,
          accountId,
          sessionId: request.sessionId,
          userMessageId: request.userMessageId,
          ownerUserId: request.ownerUserId,
          text: publicErrorText,
          status: 'error',
          error: errorMessage,
          publicErrorText,
          publicReasonCode: timeoutError?.publicReasonCode ?? 'daemon_error',
          timestamp: new Date().toISOString(),
          model: request.llmRuntime.model,
          provider: request.llmRuntime.piApi,
          traceEvents: traceEvents.length > 0 ? traceEvents : undefined,
          usage: requestScope.partialUsage,
          metadata: {
            kind: 'final',
            turn_complete: true,
          },
        };
        // 写入指定的 outbox 队列（或默认队列）
        await deliverDurableResult(request, errorResponse, pushEncryptedOutbox);
      } catch (pushError) {
        log(
          `推送错误响应失败: ${pushError instanceof Error ? pushError.message : String(pushError)}`,
        );
      }
    }
  } finally {
    executionEnded = true;
    stopLease();
    if (request?.requestId && ownsExecution) {
      activeSessions.delete(request.requestId);
      pendingCancelRequests.delete(request.requestId);
      activeRequests.delete(request.requestId);
    }
    setRequestId(requestScope, undefined);
  }
}
