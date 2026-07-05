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
import { connectRedis, disconnectRedis, getRedis } from './redis.js';
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
const AGENT_RUNTIME_ACCOUNT_CONCURRENCY = Math.max(
  1,
  Math.trunc(Number(process.env.AGENT_RUNTIME_ACCOUNT_CONCURRENCY ?? '1')) || 1,
);
// 单次请求处理的硬超时兜底：executeContainerInput 内部（SDK 工具调用循环）一旦卡在
// 某个既不 resolve 也不 reject 的 await 上，没有这层超时会导致请求永久静默、前端和
// outbox 都收不到任何事件。超时后放弃等待并按错误结束这次请求，尝试 abort 当前
// session，但无法强制打断仍在同步运行的代码（例如灾难性正则回溯）。
const AGENT_REQUEST_TIMEOUT_MS = Math.max(
  60_000,
  Math.trunc(Number(process.env.AGENT_RUNTIME_REQUEST_TIMEOUT_MS ?? '')) ||
    8 * 60 * 1000,
);
// 存活心跳：周期性写 `agent:heartbeat:{accountId}`（带 TTL）。宿主侧巡检任务
// （inbox-stall-sweeper）用它把「runtime 掉线」的发现时间从 inbox 堆积的分钟级
// 压到心跳 TTL 级；事件循环被同步阻塞（如灾难性正则回溯）时心跳会自然停跳，
// 也能被同一机制发现。优雅退出时主动删除 key，避免误报。
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TTL_MS = 30_000;

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

export const __processInboxMessageForTests = processInboxMessage;

export const __buildFatalOutboxResponseForTests = buildFatalOutboxResponse;

/**
 * 为一条"进程即将因未捕获异常/rejection 崩溃"的请求，构造推给 outbox 的错误响应。
 *
 * 抽成纯函数是为了能脱离真实 Redis/process.exit 单独测试内容是否正确
 * （error 字段是否带上了详细诊断信息，publicErrorText 是否是用户可读文案）。
 *
 * @param kind 触发崩溃的事件类型。
 * @param detail 异常的详细信息（优先用 stack，没有 stack 则用 message/字符串化结果）。
 * @param requestId 这条在途请求的 ID。
 * @param request 该请求解析出的原始 inbox 请求，用于取 accountId/sessionId 等字段。
 * @returns 可直接 JSON 序列化后 lpush 到 outbox 队列的错误响应。
 */
function buildFatalOutboxResponse(
  kind: 'uncaughtException' | 'unhandledRejection',
  detail: string,
  requestId: string,
  request: InboxRequest,
): OutboxResponse {
  return {
    type: 'response',
    requestId,
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
    metadata: { kind: 'final', turn_complete: true },
  };
}

async function processInboxMessage(
  accountId: string,
  raw: string,
  activeSessions: Map<string, { abort: () => Promise<void> }>,
  pendingCancelRequests: Map<string, number>,
  activeRequestContexts: Map<string, InboxRequest>,
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

    // 供 uncaughtException/unhandledRejection 兜底使用：进程崩溃前需要靠这份
    // 上下文（accountId/sessionId/outboxQueue 等）拼出一条错误响应推给宿主，
    // 仅存 activeSessions 的 abort 句柄不够——那里没有这些字段。
    activeRequestContexts.set(request.requestId, request);

    setRequestId(requestScope, request.requestId);
    log(
      `正在处理收件箱请求 requestId=${request.requestId} type=${request.type} accountId=${request.accountId}${request.outboxQueue ? ` outboxQueue=${request.outboxQueue}` : ''}`,
    );

    let timeoutTimer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeoutTimer = setTimeout(() => resolve('timeout'), AGENT_REQUEST_TIMEOUT_MS);
    });

    const raced = await Promise.race([
      executeContainerInput(
        {
          accountId,
          sessionId: request.sessionId,
          llmRuntime: request.llmRuntime,
          userMessage: request.userMessage,
          inputKind: request.inputKind,
          pastedBoard: request.pastedBoard,
          sessionBoardContexts: request.sessionBoardContexts,
          history: request.history ?? [],
          userName: request.userName,
          assistantName: request.assistantName,
          personaPrompt: request.personaPrompt,
          guashiScriptTemplate: request.guashiScriptTemplate,
          authorizedSkillIds: request.authorizedSkillIds,
          outboxQueue: request.outboxQueue,
        },
        requestScope,
        undefined,
        {
          onSessionReady(sessionControls) {
            activeSessions.set(request!.requestId, sessionControls);
            if (pendingCancelRequests.delete(request!.requestId)) {
              void sessionControls.abort();
            }
          },
        },
      ),
      timeoutPromise,
    ]);
    clearTimeout(timeoutTimer);

    if (raced === 'timeout') {
      // 放弃等待并尝试 abort 当前 session；若卡死原因是同步阻塞（如灾难性正则回溯），
      // abort 无法真正打断执行，但至少能让本次请求以明确错误结束，不再无限静默。
      void activeSessions.get(request.requestId)?.abort().catch(() => {});
      throw new Error(
        `请求处理超时（超过 ${Math.round(AGENT_REQUEST_TIMEOUT_MS / 1000)}s）`,
      );
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
      activeRequestContexts.delete(request.requestId);
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
  // 宿主机（local-runner.ts）通过 stdout 管道识别这行就绪信号，用来确认子进程
  // 真的连上了 Redis、具备处理请求的能力，而不是只看 spawn() 有没有抛错。
  // 用原始 write 而不是 log()：log() 走 stderr 且带日志前缀，容易和真实日志混在一起，
  // 这里要的是干净、无歧义的控制信号。
  process.stdout.write('__FATECLAW_AGENT_READY__\n');
  const redis = getRedis();

  // 存活心跳：立即写一次，此后周期续写。SET 带 PX 过期，进程死亡/事件循环
  // 卡死后 key 自动消失，宿主侧即可判定掉线。
  const heartbeatKey = `agent:heartbeat:${ctx.accountId}`;
  const writeHeartbeat = () => {
    void redis
      .set(heartbeatKey, String(Date.now()), 'PX', HEARTBEAT_TTL_MS)
      .catch(() => {
        // 心跳写失败（如 Redis 抖动）不影响主流程；持续失败会表现为心跳缺失，
        // 由宿主侧告警接管。
      });
  };
  writeHeartbeat();
  const heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  // 退出协调：收到信号后停止接收新消息，等待正在处理的请求完成（最多 N 秒），
  // 然后清理 Redis/DB 连接。避免 in-flight 请求被强杀导致响应丢失。
  let shuttingDown = false;
  const activeTasks = new Map<string, Promise<void>>();
  const activeSessions = new Map<string, { abort: () => Promise<void> }>();
  const pendingCancelRequests = new Map<string, number>();
  const activeRequestContexts = new Map<string, InboxRequest>();
  const SHUTDOWN_DRAIN_MS = 30_000;

  // 全局异常兜底：正常情况下每个请求的异常都会被 processInboxMessage 的
  // try/catch 接住并推一条错误响应；但如果某处异步代码漏掉了 catch，
  // Node 会把它变成这里的 uncaughtException/unhandledRejection，默认行为是
  // 直接崩溃退出，不给任何还在处理中的请求留下解释。这里在真正退出前，
  // 尽力给所有仍在处理中的请求各推一条详细的错误响应，再重启进程——
  // 无法覆盖 SIGKILL/系统 OOM 直接杀死进程的情况，那部分由宿主机侧
  // （local-runner.ts 感知子进程退出）兜底。
  let fatalErrorHandled = false;
  const handleFatalProcessError = (
    kind: 'uncaughtException' | 'unhandledRejection',
    error: unknown,
  ): void => {
    if (fatalErrorHandled) return;
    fatalErrorHandled = true;

    const detail =
      error instanceof Error ? error.stack || error.message : String(error);
    log(
      `${kind === 'uncaughtException' ? '未捕获异常' : '未处理的 Promise rejection'}，进程即将退出并尝试通知在途请求: ${detail}`,
    );

    const notifyActiveRequests = async () => {
      for (const [requestId, request] of activeRequestContexts) {
        try {
          const errorResponse = buildFatalOutboxResponse(
            kind,
            detail,
            requestId,
            request,
          );
          const outboxQueue =
            request.outboxQueue ?? `ipc:${request.accountId}:outbox`;
          await getRedis().lpush(outboxQueue, JSON.stringify(errorResponse));
        } catch (pushError) {
          log(
            `崩溃兜底推送失败 requestId=${requestId}: ${pushError instanceof Error ? pushError.message : String(pushError)}`,
          );
        }
      }
    };

    // 通知本身也设上限：不能让一次卡住的 Redis 调用拖着进程迟迟无法退出重启。
    void Promise.race([notifyActiveRequests(), sleep(5_000)]).finally(() => {
      process.exit(1);
    });
  };

  process.on('uncaughtException', (err) => {
    handleFatalProcessError('uncaughtException', err);
  });
  process.on('unhandledRejection', (reason) => {
    handleFatalProcessError('unhandledRejection', reason);
  });

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
    // 优雅退出：停跳并主动删除心跳 key，避免宿主侧把正常回收误报为掉线。
    clearInterval(heartbeatTimer);
    await redis.del(heartbeatKey).catch(() => {});
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
      const result = await redis.brpop(
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
        activeRequestContexts,
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
