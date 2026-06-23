import { randomUUID } from 'node:crypto';

import { closeAgentDb } from './agent-db.js';
import { getContext, initContext } from './context.js';
import { executeContainerInput } from './request-boundary.js';
import { log } from './io.js';
import {
  createRequestScope,
  listScopedTraceEvents,
  setRequestId,
} from './request-scope.js';
import {
  connectRedis,
  disconnectRedis,
  getBlockingRedis,
  getRedis,
} from './redis.js';
import {
  CancelInboxRequest,
  InboxRequest,
  LlmRuntimeSnapshot,
  OutboxResponse,
} from './types.js';

type CancelQueueRedis = {
  rpop: (key: string) => Promise<string | null>;
};

const PENDING_CANCEL_TTL_MS = 35 * 60 * 1000;
// 单账号并发。注意:并发≥2 时主循环会在某轮任务仍在生成时继续 brpop 抓下一个任务,故
// brpop 必须走 getBlockingRedis() 的独立连接(见 loop()),否则它会把发流式 token 的
// 主连接 publish 憋到回合结束才一次性 flush。改并发前务必保持这条隔离不变量。
const AGENT_RUNTIME_ACCOUNT_CONCURRENCY = Math.max(
  1,
  Math.trunc(Number(process.env.AGENT_RUNTIME_ACCOUNT_CONCURRENCY ?? '1')) || 1,
);
// 单次请求最长处理时长(默认 30 分钟)。超时后强制中断会话并抛错,由 catch 写一条
// error 终止响应——否则 LLM provider 挂起会让 executeContainerInput 永久 await:
// 既不产出也不报错,daemon 占满账号唯一并发槽,该用户后续所有消息全部卡死,
// 宿主机也只能等 35 分钟锁 TTL。详见对话偶发卡死排查。
const AGENT_RUNTIME_REQUEST_TIMEOUT_MS = Math.max(
  60_000,
  Math.trunc(Number(process.env.AGENT_RUNTIME_REQUEST_TIMEOUT_MS ?? '1800000')) ||
    1_800_000,
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupExpiredPendingCancelRequests(
  pendingCancelRequests: Map<string, number>,
  now = Date.now(),
): void {
  for (const [requestId, createdAt] of pendingCancelRequests) {
    if (now - createdAt > PENDING_CANCEL_TTL_MS) {
      pendingCancelRequests.delete(requestId);
    }
  }
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
    (record.baseUrl === undefined || typeof record.baseUrl === 'string')
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

function parseCancelInboxRequest(raw: string): CancelInboxRequest | null {
  const parsed = JSON.parse(raw) as Partial<CancelInboxRequest>;
  if (parsed.type !== 'cancel' || !parsed.requestId || !parsed.accountId) {
    return null;
  }

  return parsed as CancelInboxRequest;
}

async function drainCancelRequests(
  accountId: string,
  activeSessions: Map<string, { abort: () => Promise<void> }>,
  pendingCancelRequests: Map<string, number>,
  redis: CancelQueueRedis = getRedis(),
): Promise<void> {
  cleanupExpiredPendingCancelRequests(pendingCancelRequests);
  while (true) {
    const raw = await redis.rpop(`ipc:${accountId}:cancel`);
    if (typeof raw !== 'string') {
      return;
    }

    try {
      const cancelRequest = parseCancelInboxRequest(raw);
      if (!cancelRequest) {
        log('忽略无效的 cancel 请求');
        continue;
      }
      if (cancelRequest.accountId !== accountId) {
        log(
          `忽略账号不匹配的 cancel 请求 expected=${accountId} actual=${cancelRequest.accountId}`,
        );
        continue;
      }

      const activeSession = activeSessions.get(cancelRequest.requestId);
      if (activeSession) {
        await activeSession.abort();
        log(
          `已中断收件箱请求 requestId=${cancelRequest.requestId} reason=${cancelRequest.reason ?? 'user_stop'}`,
        );
      } else {
        pendingCancelRequests.set(cancelRequest.requestId, Date.now());
        log(
          `收到中断请求，等待活动会话就绪 requestId=${cancelRequest.requestId}`,
        );
      }
    } catch (error) {
      log(
        `处理 cancel 请求失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * 测试专用：从指定 Redis stub 中清空 cancel 队列。
 *
 * @param accountId 当前 agent-runtime 账号 ID。
 * @param activeSessions 正在执行的 session 控制表。
 * @param pendingCancelRequests 尚未等到 session ready 的取消请求 ID 与接收时间。
 * @param redis 只需实现 rpop 的测试替身。
 */
export async function __drainCancelRequestsForTests(
  accountId: string,
  activeSessions: Map<string, { abort: () => Promise<void> }>,
  pendingCancelRequests: Map<string, number>,
  redis: { rpop: (key: string) => Promise<string | null> },
): Promise<void> {
  await drainCancelRequests(
    accountId,
    activeSessions,
    pendingCancelRequests,
    redis,
  );
}

export function __cleanupPendingCancelRequestsForTests(
  pendingCancelRequests: Map<string, number>,
  now?: number,
): void {
  cleanupExpiredPendingCancelRequests(pendingCancelRequests, now);
}

export function __getAgentRuntimeAccountConcurrencyForTests(): number {
  return AGENT_RUNTIME_ACCOUNT_CONCURRENCY;
}

async function processInboxMessage(
  accountId: string,
  raw: string,
  activeSessions: Map<string, { abort: () => Promise<void> }>,
  pendingCancelRequests: Map<string, number>,
): Promise<void> {
  let request: InboxRequest | undefined;
  const requestScope = createRequestScope();

  try {
    request = parseInboxRequest(raw);

    if (request.accountId !== accountId) {
      throw new Error(
        `inbox 请求账号不匹配: expected=${accountId} actual=${request.accountId}`,
      );
    }

    setRequestId(requestScope, request.requestId);
    log(
      `正在处理收件箱请求 requestId=${request.requestId} type=${request.type} accountId=${request.accountId}${request.outboxQueue ? ` outboxQueue=${request.outboxQueue}` : ''}`,
    );

    const inboxRequestId = request.requestId;
    const containerExecution = executeContainerInput(
      {
        accountId,
        sessionId: request.sessionId,
        piSessionId: request.piSessionId,
        llmRuntime: request.llmRuntime,
        userMessage: request.userMessage,
        inputKind: request.inputKind,
        pastedBoard: request.pastedBoard,
        sessionBoardContexts: request.sessionBoardContexts,
        history: request.history ?? [],
        userName: request.userName,
        assistantName: request.assistantName,
        personaPrompt: request.personaPrompt,
        authorizedSkillBundleIds: request.authorizedSkillBundleIds,
        authorizedWorkflowSkillIds: request.authorizedWorkflowSkillIds,
        outboxQueue: request.outboxQueue,
      },
      requestScope,
      undefined,
      {
        onSessionReady(sessionControls) {
          activeSessions.set(inboxRequestId, sessionControls);
          if (pendingCancelRequests.delete(inboxRequestId)) {
            void sessionControls.abort();
          }
        },
      },
    );
    // 超时后这条执行链会被遗弃(executeContainerInput 内部 catch,不会抛),先挂一个
    // 兜底 catch 防止极端情况下的未处理 promise 异常。
    containerExecution.catch(() => {});

    // 给单次请求套一个可中断的超时:超时则尽力 abort 已就绪的会话(尽快释放底层 LLM
    // 连接与账号并发槽),并抛错落入下方 catch 写出 error 终止响应,绝不无限等待。
    let requestTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const output = await Promise.race([
      containerExecution,
      new Promise<never>((_, reject) => {
        requestTimeoutTimer = setTimeout(() => {
          void activeSessions
            .get(inboxRequestId)
            ?.abort()
            .catch(() => {});
          reject(
            new Error(
              `agent 请求超时(${AGENT_RUNTIME_REQUEST_TIMEOUT_MS}ms 未完成)`,
            ),
          );
        }, AGENT_RUNTIME_REQUEST_TIMEOUT_MS);
      }),
    ]).finally(() => {
      if (requestTimeoutTimer) clearTimeout(requestTimeoutTimer);
    });

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
    await getRedis().lpush(outboxQueue, JSON.stringify(response));

    log(
      `已完成收件箱请求 requestId=${request.requestId} status=${output.status} outbox=${outboxQueue}`,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`处理收件箱消息失败: ${errorMessage}`);

    // 若已解析出 requestId，推送错误响应，避免宿主机无限等待
    if (request?.requestId) {
      try {
        // 兜底取 trace 缓冲：request boundary 之外的异常（例如 parseInboxRequest 后紧跟
        // 的其他错误）可能已有部分 trace 产生；此时 request-state 还没被下一个
        // 请求 reset，数据是安全的。取不到也无妨（undefined 会被宿主端跳过）。
        const traceEvents = listScopedTraceEvents(requestScope);
        const errorResponse: OutboxResponse = {
          type: 'response',
          requestId: request.requestId,
          accountId,
          sessionId: request.sessionId,
          userMessageId: request.userMessageId,
          ownerUserId: request.ownerUserId,
          text: '这次没有完成，原因：处理收件箱请求失败。',
          status: 'error',
          error: errorMessage,
          publicErrorText: '这次没有完成，原因：处理收件箱请求失败。',
          publicReasonCode: 'daemon_error',
          timestamp: new Date().toISOString(),
          traceEvents: traceEvents.length > 0 ? traceEvents : undefined,
          metadata: {
            kind: 'final',
            turn_complete: true,
          },
        };
        // 写入指定的 outbox 队列（或默认队列）
        const errorOutboxQueue =
          request.outboxQueue ?? `ipc:${accountId}:outbox`;
        await getRedis().lpush(errorOutboxQueue, JSON.stringify(errorResponse));
      } catch (pushError) {
        log(
          `推送错误响应失败: ${pushError instanceof Error ? pushError.message : String(pushError)}`,
        );
      }
    }
  } finally {
    if (request?.requestId) {
      activeSessions.delete(request.requestId);
      pendingCancelRequests.delete(request.requestId);
    }
    setRequestId(requestScope, undefined);
  }
}

function readInboxRequestIdForTask(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { requestId?: unknown };
    if (typeof parsed.requestId === 'string' && parsed.requestId.trim()) {
      return parsed.requestId;
    }
  } catch {
    // 无效 JSON 会在 processInboxMessage 中生成错误响应；这里只需要 task key。
  }
  return `unknown-${randomUUID()}`;
}

async function cleanup(): Promise<void> {
  log('正在关闭连接...');
  await closeAgentDb();
  await disconnectRedis();
}

async function loop(): Promise<void> {
  const ctx = initContext();
  await connectRedis();
  // brpop 走专用阻塞连接,绝不与发流式 token 的主连接(getRedis)共用,否则并发≥2 时
  // brpop 会把同连接上的 publish 憋到回合结束才一次性 flush(见 redis.ts 注释)。
  const blockingRedis = getBlockingRedis();

  // 退出协调：收到信号后停止接收新消息，等待正在处理的请求完成（最多 N 秒），
  // 然后清理 Redis/DB 连接。避免 in-flight 请求被强杀导致响应丢失。
  let shuttingDown = false;
  const activeTasks = new Map<string, Promise<void>>();
  const activeSessions = new Map<string, { abort: () => Promise<void> }>();
  const pendingCancelRequests = new Map<string, number>();
  const SHUTDOWN_DRAIN_MS = 30_000;

  const onExit = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(
      `收到 ${signal}，等待 in-flight 请求完成（最多 ${SHUTDOWN_DRAIN_MS}ms）...`,
    );
    if (activeTasks.size > 0) {
      await Promise.race([
        Promise.allSettled([...activeTasks.values()]),
        sleep(SHUTDOWN_DRAIN_MS),
      ]);
    }
    try {
      await cleanup();
    } catch (err) {
      log(`cleanup 失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => {
    void onExit('SIGINT');
  });
  process.once('SIGTERM', () => {
    void onExit('SIGTERM');
  });

  const cancelDrainLoop = (async () => {
    while (!shuttingDown) {
      try {
        await drainCancelRequests(
          ctx.accountId,
          activeSessions,
          pendingCancelRequests,
        );
        cleanupExpiredPendingCancelRequests(pendingCancelRequests);
      } catch (error) {
        log(
          `cancel drain 循环出错，将继续重试: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await sleep(250);
    }
  })();

  log(
    `常驻 agent 已启动，账号 ${ctx.accountId}，通过 Redis BRPOP 监听，并发=${AGENT_RUNTIME_ACCOUNT_CONCURRENCY}`,
  );

  while (!shuttingDown) {
    try {
      while (
        activeTasks.size >= AGENT_RUNTIME_ACCOUNT_CONCURRENCY &&
        !shuttingDown
      ) {
        await Promise.race([...activeTasks.values(), sleep(250)]);
      }
      if (shuttingDown) break;
      // 30s timeout 让退出信号能在合理时间内被察觉，并允许 ioredis 自动重连
      const result = await blockingRedis.brpop(
        `ipc:${ctx.accountId}:inbox:member`,
        `ipc:${ctx.accountId}:inbox`,
        30,
      );
      if (!result || shuttingDown) continue;

      const [, raw] = result;
      const requestId = readInboxRequestIdForTask(raw);
      const task = processInboxMessage(
        ctx.accountId,
        raw,
        activeSessions,
        pendingCancelRequests,
      )
        .catch((error) => {
          log(
            `收件箱任务异常结束: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          activeTasks.delete(requestId);
        });
      activeTasks.set(requestId, task);
    } catch (error) {
      log(
        `常驻循环出错: ${error instanceof Error ? error.message : String(error)}`,
      );
      // 短暂等待后重试，避免紧密循环
      await sleep(1000);
    }
  }
  await cancelDrainLoop.catch((error) => {
    log(
      `cancel drain 循环退出: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

if (process.env.NODE_ENV !== 'test') {
  loop().catch((error) => {
    log(
      `常驻 agent 致命错误: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
