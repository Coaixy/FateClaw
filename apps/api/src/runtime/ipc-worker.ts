import { submitAiChatRequest } from './ai-chat-dispatch.js';
import { releasePerUserMeteredSlotByRequestId } from './metered-request-slots.js';
import { releaseLocalAgentLeaseForPending } from './request-agent-lease.js';
export { releasePerUserMeteredSlotByRequestId } from './metered-request-slots.js';
import { decodeRuntimeIpc, encodeRuntimeIpc } from './ipc-security.js';
import { InvalidRuntimeIpcError } from '@fateclaw/contracts/runtime-ipc';
import { paipanRequestQueue } from '@fateclaw/contracts/agent/paipan';
import { processPaipanToolPayload } from './paipan-tool-handler.js';
import { visualizationRequestQueue } from '@fateclaw/contracts/agent/visualization';
import { processVisualizationToolPayload } from './visualization-tool-handler.js';
import {
  releaseGlobalAgentSlot,
  resetAgentScheduler,
  getAgentConcurrencyKeys,
  dequeueGlobalAgentWaiter,
} from './agent-scheduler.js';
export { releaseGlobalAgentSlot } from './agent-scheduler.js';
import type { AiChatSubmission } from './request-types.js';
import {
  claimAiChatResult,
  acknowledgeAiChatResult,
  quarantineAiChatResult,
} from './reliable-ai-chat-outbox.js';
/**
 * IPC 工作线程：Redis BRPOP 监听 + 收件箱请求管理。
 * 具体的 outbox 消息处理逻辑拆分到各自的 handler 模块。
 */

import { Redis } from 'ioredis';

import { processOutboxPayload } from './ipc-outbox-handler.js';
import { processAiChatOutboxPayload } from './ipc-ai-chat-outbox-handler.js';

const IPC_LISTENER_RESTART_INITIAL_MS = 1_000;
const IPC_LISTENER_RESTART_MAX_MS = 30_000;
const IPC_LISTENER_STABLE_MS = 60_000;
import {
  InvalidAiChatPayloadError,
  buildAiChatErrorResponsePayload,
  type CancelInboxRequestPayload,
  InboxRequestResult,
  PendingInboxRequest,
} from './ipc-payloads.js';
import {
  releaseSessionProcessingLock,
  sessionProcessingLockKey,
} from './session-processing-lock.js';
import { logger } from '#infrastructure/logger';
import { getRedis } from '#infrastructure/redis';
import {
  onLocalAgentProcessExit,
  type LocalAgentProcessExitInfo,
} from './local-runner.js';
import { requestAgentCancellation } from '#infrastructure/repositories/agent-requests-repository';
export type { InboxRequestResult } from './ipc-payloads.js';

let ipcWorkerRunning = false;
const pendingInboxRequests = new Map<string, PendingInboxRequest>();
/** AI Chat 专属的 pending 请求 Map（完全隔离） */
const pendingAiChatRequests = new Map<string, PendingInboxRequest>();
const accountListeners = new Map<
  string,
  { running: boolean; redis: Redis; aiRedis: Redis }
>();
const desiredAccountListeners = new Set<string>();
const listenerSupervisors = new Map<string, { running: boolean }>();
/**
 * 常驻（pinned）监听账号：微信 Claw 账号随进程生命周期常驻，不参与空闲回收。
 * 站内 AI Chat 的 `web:{userId}` 监听是发消息时懒创建的，历史上只增不删——
 * 每个监听器独占一条 Redis duplicate 连接 + 常驻 BRPOP 协程，随活跃用户数
 * 无界增长。非 pinned 监听器空闲超时且无在途请求时自动退出（见 listenForAccount），
 * 回收后迟到的 outbox 消息由 inbox-stall-sweeper 的 outbox 巡检兜底消费，不会丢。
 */
const pinnedAccountListeners = new Set<string>();
/** 非 pinned 监听器的空闲回收阈值：超过此时长无任何 outbox 消息且无在途请求即退出。 */
const ACCOUNT_LISTENER_IDLE_TTL_MS = 10 * 60 * 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isResponseQueue(queue: string): boolean {
  return queue.endsWith(':outbox') || queue.endsWith(':ai-chat:outbox');
}

function pendingMapForQueue(
  queue: string,
): Map<string, PendingInboxRequest> | null {
  if (queue.endsWith(':ai-chat:outbox')) return pendingAiChatRequests;
  if (queue.endsWith(':outbox')) return pendingInboxRequests;
  return null;
}

async function releaseGlobalAgentSlotForPayload(
  queue: string,
  payload: unknown,
): Promise<void> {
  if (!isResponseQueue(queue)) return;
  if (!payload || typeof payload !== 'object') return;
  const type = (payload as { type?: unknown }).type;
  if (type !== 'response') return;
  const requestId = (payload as { requestId?: unknown }).requestId;
  if (typeof requestId !== 'string') return;
  const pending = pendingMapForQueue(queue)?.get(requestId);
  await releaseGlobalAgentSlot(pending?.concurrencySlotId ?? requestId);
  await releasePerUserMeteredSlotByRequestId(requestId);
}

function buildAiChatCancelPayload(input: {
  requestId: string;
  accountId: string;
  sessionId: string;
  reason?: string;
}): string {
  const payload: CancelInboxRequestPayload = {
    type: 'cancel',
    requestId: input.requestId,
    accountId: input.accountId,
    sessionId: input.sessionId,
    reason: input.reason,
    timestamp: new Date().toISOString(),
  };
  return JSON.stringify(payload);
}

/**
 * 取消指定 AI Chat 会话当前正在执行的请求。
 *
 * @param sessionId 站内 AI Chat 会话 ID。
 * @param accountId 会话所属运行时账号 ID；当当前 API 进程没有 pending 内存态时用于定位 cancel 队列。
 * @param reason 取消原因，写入 cancel payload 便于运行时日志追踪。
 * @returns 找到并取消了 active pending request 时返回 true，否则返回 false。
 */
export async function cancelAiChatSessionRequest(
  sessionId: string,
  accountId?: string,
  reason = 'user_stop',
): Promise<boolean> {
  const processingKey = sessionProcessingLockKey(sessionId);
  const requestId = await getRedis().get(processingKey);
  if (!requestId) {
    return false;
  }

  const pending = pendingAiChatRequests.get(requestId);
  if (!pending?.sessionId || pending.sessionId !== sessionId) {
    if (pending) {
      return false;
    }
  }
  const runtimeAccountId = pending?.accountId ?? accountId;
  if (!runtimeAccountId) {
    return false;
  }

  await requestAgentCancellation(requestId);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingAiChatRequests.delete(requestId);
  }
  await releaseSessionProcessingLock(sessionId, requestId);
  await releaseGlobalAgentSlot(pending?.concurrencySlotId ?? requestId);
  await releasePerUserMeteredSlotByRequestId(requestId);
  await releaseLocalAgentLeaseForPending(pending, {
    accountId: runtimeAccountId,
    requestId,
    reason: 'cancel',
  });
  // 取消不再就地 settle(0,0)：那会把已消耗的 Token 标记 charged@0、永久关账，
  // 导致取消前真实消耗的 token 全部免费。改为保留预留 charge_state='pending'，
  // 由 billing-sweeper 按 daemon 中断响应落库的真实 usage 兜底补结算。
  await getRedis().lpush(
    `ipc:${runtimeAccountId}:cancel`,
    encodeRuntimeIpc(
      runtimeAccountId,
      `ipc:${runtimeAccountId}:cancel`,
      buildAiChatCancelPayload({
        requestId,
        accountId: runtimeAccountId,
        sessionId,
        reason,
      }),
      60_000,
    ),
  );
  pending?.resolve({
    requestId,
    status: 'error',
    text: '',
    error: 'cancelled',
    publicErrorText: '',
    publicReasonCode: reason,
    metadata: {
      kind: 'cancelled',
      turn_complete: false,
    },
  });
  logger.info(
    { accountId: runtimeAccountId, requestId, sessionId, reason },
    'AI Chat 请求已标记取消',
  );
  return true;
}

function hasPendingRequestsForAccount(accountId: string): boolean {
  for (const pending of pendingAiChatRequests.values()) {
    if (pending.accountId === accountId) return true;
  }
  for (const pending of pendingInboxRequests.values()) {
    if (pending.accountId === accountId) return true;
  }
  return false;
}

/**
 * 为单个 account 启动 BRPOP 监听协程。
 */
async function listenForAccount(accountId: string): Promise<void> {
  // The 1s reads fit within the inherited 5s deadline; ioredis treats 0 as immediate.
  const redis = getRedis().duplicate();
  const aiRedis = getRedis().duplicate();
  for (const client of [redis, aiRedis]) {
    client.on('error', (err) => {
      // Redis errors can carry command arguments, including authentication values.
      logger.warn(
        {
          accountId,
          err: { type: err.name, message: err.message, stack: err.stack },
        },
        'Redis IPC 连接异常',
      );
    });
  }
  const listener = { running: true, redis, aiRedis };
  accountListeners.set(accountId, listener);
  let lastActivityAtMs = Date.now();

  logger.info({ accountId }, '启动 Redis IPC 监听');

  try {
    // The lazy duplicate inherits disabled offline queuing, so BRPOP must wait for readiness.
    await Promise.all([redis.connect(), aiRedis.connect()]);
    const consume = async (aiChat: boolean) => {
      while (listener.running) {
        const queueName = aiChat
          ? `ipc:${accountId}:ai-chat:outbox`
          : `ipc:${accountId}:outbox`;
        const aiRaw = aiChat
          ? await claimAiChatResult(queueName, aiRedis)
          : null;
        const result = aiChat
          ? aiRaw === null
            ? null
            : [queueName, aiRaw]
          : await redis.brpop(
              queueName,
              paipanRequestQueue(accountId),
              visualizationRequestQueue(accountId),
              1,
            );

        if (!result) {
          // 空闲回收：非 pinned 监听器长时间没有任何消息、且账号名下无在途请求时
          // 自行退出，释放 duplicate 连接。同时摘掉 desired 标记，让 supervisor
          // 一并退出而不是立刻重启。
          if (
            !pinnedAccountListeners.has(accountId) &&
            Date.now() - lastActivityAtMs > ACCOUNT_LISTENER_IDLE_TTL_MS &&
            !hasPendingRequestsForAccount(accountId)
          ) {
            desiredAccountListeners.delete(accountId);
            listener.running = false;
            logger.info(
              { accountId, idleTtlMs: ACCOUNT_LISTENER_IDLE_TTL_MS },
              'Redis IPC 监听空闲超时，自动回收',
            );
          }
          continue;
        }
        lastActivityAtMs = Date.now();

        const [queue, raw] = result;

        try {
          const payload = JSON.parse(
            decodeRuntimeIpc(accountId, queue, raw),
          ) as unknown;
          if (queue === paipanRequestQueue(accountId)) {
            await processPaipanToolPayload(payload, accountId);
          } else if (queue === visualizationRequestQueue(accountId)) {
            await processVisualizationToolPayload(payload, accountId);
          } else if (queue.endsWith(':ai-chat:outbox')) {
            // AI Chat 专属队列：永远不发微信
            await processAiChatOutboxPayload(
              payload,
              accountId,
              pendingAiChatRequests,
            );
            await acknowledgeAiChatResult(queue, raw);
          } else if (queue.endsWith(':outbox')) {
            await processOutboxPayload(
              payload,
              accountId,
              pendingInboxRequests,
            );
          }
          await releaseGlobalAgentSlotForPayload(queue, payload).catch(
            (err) => {
              logger.warn({ accountId, queue, err }, '释放 agent 并发槽位失败');
            },
          );
        } catch (error) {
          // AI Chat keeps its processing copy for retry; external-message delivery
          // retains its existing non-replay policy.
          logger.error(
            { accountId, queue, err: error },
            '处理 Redis IPC 消息失败',
          );

          // 兜底：如果 outbox response 处理失败且 pending 仍未被 resolve，在此清理
          if (queue.endsWith(':ai-chat:outbox')) {
            if (
              error instanceof SyntaxError ||
              error instanceof InvalidRuntimeIpcError ||
              error instanceof InvalidAiChatPayloadError
            )
              await quarantineAiChatResult(queue, raw);
            // Storage failures retain the transport copy and pending waiter for retry.
            await new Promise((resolve) => setTimeout(resolve, 1000));
            continue;
          }
          if (queue.endsWith(':outbox')) {
            try {
              const parsed = JSON.parse(raw) as Record<string, unknown>;
              const requestId =
                typeof parsed.requestId === 'string'
                  ? parsed.requestId
                  : undefined;
              if (requestId) {
                // 根据队列类型选择对应的 pending Map
                const pendingMap = queue.endsWith(':ai-chat:outbox')
                  ? pendingAiChatRequests
                  : pendingInboxRequests;
                const pending = pendingMap.get(requestId);
                if (pending) {
                  clearTimeout(pending.timeout);
                  pendingMap.delete(requestId);
                  const errorMsg =
                    error instanceof Error ? error.message : String(error);
                  logger.warn(
                    { accountId, requestId },
                    '兜底 reject 未完成的 pending 请求',
                  );
                  await releaseGlobalAgentSlot(pending.concurrencySlotId).catch(
                    () => {},
                  );
                  await releasePerUserMeteredSlotByRequestId(requestId).catch(
                    () => {},
                  );
                  await releaseLocalAgentLeaseForPending(pending, {
                    accountId,
                    requestId,
                    reason: 'outbox_fallback_error',
                  });
                  await releaseSessionProcessingLock(
                    pending.sessionId,
                    pending.sessionProcessingRequestId ?? requestId,
                  ).catch(() => {});
                  pending.reject(new Error(`outbox 处理失败: ${errorMsg}`));
                }
              }
            } catch {
              // JSON 已经在上面成功解析过，这里不应失败，但保险起见忽略
            }
          }
        }
      }
    };
    await Promise.all([consume(false), consume(true)]);
  } finally {
    listener.running = false;
    aiRedis.disconnect();
    // QUIT on a broken read-only connection can mask the original listener failure.
    redis.disconnect();
    if (accountListeners.get(accountId) === listener)
      accountListeners.delete(accountId);
    logger.info({ accountId }, 'Redis IPC 监听已停止');
  }
}

function startAccountListenerSupervisor(accountId: string): void {
  if (listenerSupervisors.has(accountId)) {
    logger.debug({ accountId }, 'Redis IPC 监听 supervisor 已存在，跳过');
    return;
  }
  const supervisor = { running: true };
  listenerSupervisors.set(accountId, supervisor);
  void (async () => {
    let failures = 0;
    try {
      while (supervisor.running && desiredAccountListeners.has(accountId)) {
        const startedAt = Date.now();
        try {
          await listenForAccount(accountId);
          if (!desiredAccountListeners.has(accountId)) {
            break;
          }
          logger.warn({ accountId }, 'Redis IPC 监听意外停止，准备重启');
        } catch (err) {
          if (!desiredAccountListeners.has(accountId)) {
            break;
          }
          logger.error(
            { accountId, err, retry: failures + 1 },
            'Redis IPC 监听异常退出，准备重启',
          );
        }
        if (Date.now() - startedAt >= IPC_LISTENER_STABLE_MS) {
          failures = 0;
        } else {
          failures += 1;
        }
        const backoffMs = Math.min(
          IPC_LISTENER_RESTART_MAX_MS,
          IPC_LISTENER_RESTART_INITIAL_MS * 2 ** Math.max(0, failures - 1),
        );
        await delay(backoffMs);
      }
    } finally {
      listenerSupervisors.delete(accountId);
    }
  })();
}

/**
 * 把本地 agent-runtime 子进程的退出详情，格式化成便于排障的详细描述。
 *
 * @param info local-runner.ts 上报的子进程退出/出错详情。
 * @returns 写入日志和 error 字段用的详细文案（不面向终端用户）。
 */
function describeLocalAgentExitInfo(info: LocalAgentProcessExitInfo): string {
  if (info.reason === 'error') {
    return `子进程触发 error 事件：${info.error?.message ?? String(info.error)}`;
  }
  const looksLikeOom = info.signal === 'SIGKILL' || info.code === 137;
  const base = `进程退出，code=${info.code ?? 'null'}，signal=${info.signal ?? 'null'}`;
  return looksLikeOom
    ? `${base}（code=137 或 SIGKILL 通常意味着被系统 OOM-Killer 强制终止，建议排查内存占用）`
    : base;
}

/**
 * 本地 agent-runtime 子进程异常退出/崩溃时，把该账号名下所有仍在等待响应的
 * AI Chat 请求统一标记为失败。
 *
 * 背景：正常情况下请求失败会由 agent-runtime 自己推一条 error 响应到 outbox；
 * 但如果子进程本身崩溃或被系统杀死，它根本没机会推任何东西——若不在这里主动兜底，
 * 用户只能干等到 AI_CHAT_REQUEST_TIMEOUT（默认 30 分钟）粗粒度超时才会收到提示。
 * 复用 processAiChatOutboxPayload 走和真实 error 响应完全一致的落库/推送/清理流程。
 *
 * @param accountId 崩溃/退出的本地 agent-runtime 进程所属账号 ID。
 * @param info 子进程退出详情（退出码/信号/异常），写入 error 字段供排障使用；
 *             面向用户的文案是更友好的固定提示，不直接暴露这些内部细节。
 */
async function failInFlightAiChatRequestsForAccount(
  accountId: string,
  info: LocalAgentProcessExitInfo,
): Promise<void> {
  const affected = [...pendingAiChatRequests.entries()].filter(
    ([, pending]) =>
      pending.accountId === accountId && Boolean(pending.localAgentLeaseId),
  );
  if (affected.length === 0) return;

  const detail = describeLocalAgentExitInfo(info);
  logger.warn(
    {
      accountId,
      requestIds: affected.map(([requestId]) => requestId),
      detail,
    },
    'AI Chat: 本地 agent-runtime 进程异常退出，批量标记在途请求为失败',
  );

  for (const [requestId, pending] of affected) {
    const publicErrorText =
      '处理这次请求的后台进程意外退出（可能是资源不足或内部错误），本轮回复未完成，请重新发送试试。';
    await processAiChatOutboxPayload(
      buildAiChatErrorResponsePayload({
        accountId,
        requestId,
        sessionId: pending.sessionId,
        userMessageId: pending.userMessageId,
        ownerUserId: pending.ownerUserId,
        publicErrorText,
        error: `本地 agent-runtime 进程异常退出：${detail}`,
        reasonCode: 'agent_process_exited',
        syntheticTerminal: true,
      }),
      accountId,
      pendingAiChatRequests,
    ).catch((err) => {
      logger.error(
        { accountId, requestId, err },
        'AI Chat: 进程崩溃后标记失败响应也失败了',
      );
    });
  }
}

export function startIpcWorker(enabledAccountIds: string[]): void {
  if (ipcWorkerRunning) {
    logger.debug('IPC 工作线程已在运行，跳过重复启动');
    return;
  }

  onLocalAgentProcessExit((accountId, info) => {
    void failInFlightAiChatRequestsForAccount(accountId, info).catch((err) => {
      logger.error(
        { accountId, err },
        'AI Chat: 处理本地 agent-runtime 崩溃通知失败',
      );
    });
  });

  ipcWorkerRunning = true;
  logger.info(
    { accounts: enabledAccountIds.length },
    'Redis IPC 工作线程已启动',
  );

  for (const accountId of enabledAccountIds) {
    // 微信 Claw 账号监听随进程常驻，不参与空闲回收。
    addAccountListener(accountId, { pinned: true });
  }
}

/**
 * 为指定账号确保 outbox 监听协程存在。
 *
 * @param accountId 运行时账号 ID（微信账号或 `web:{userId}`）。
 * @param options.pinned 为 true 时监听器常驻、不参与空闲回收（微信场景）；
 *                       默认 false（站内 AI Chat 懒创建监听，空闲自动回收）。
 */
export function addAccountListener(
  accountId: string,
  options?: { pinned?: boolean },
): void {
  if (options?.pinned) {
    pinnedAccountListeners.add(accountId);
  }
  desiredAccountListeners.add(accountId);
  startAccountListenerSupervisor(accountId);
}

export function removeAccountListener(accountId: string): void {
  pinnedAccountListeners.delete(accountId);
  desiredAccountListeners.delete(accountId);
  const supervisor = listenerSupervisors.get(accountId);
  if (supervisor) {
    supervisor.running = false;
  }
  const listener = accountListeners.get(accountId);
  if (listener) {
    listener.running = false;
    logger.info({ accountId }, '正在停止 Redis IPC 监听');
  }
}

/** IPC 监听与 pending 请求的状态快照（供运维状态面板展示）。 */
export interface IpcWorkerStatus {
  /** 活跃监听器账号列表。 */
  listenerAccounts: string[];
  /** 常驻（pinned，微信）监听器数量。 */
  pinnedListenerCount: number;
  /** 微信 pending 请求数。 */
  pendingInboxCount: number;
  /** AI Chat pending 请求数。 */
  pendingAiChatCount: number;
}

/**
 * 读取 IPC worker 的运行状态快照。
 *
 * @returns 监听器与 pending 计数；无副作用，仅用于运维观测。
 */
export function getIpcWorkerStatus(): IpcWorkerStatus {
  return {
    listenerAccounts: [...accountListeners.keys()],
    pinnedListenerCount: pinnedAccountListeners.size,
    pendingInboxCount: pendingInboxRequests.size,
    pendingAiChatCount: pendingAiChatRequests.size,
  };
}

export function _resetIpcWorkerForTests(): void {
  resetAgentScheduler();
  for (const pending of pendingInboxRequests.values()) {
    clearTimeout(pending.timeout);
  }
  pendingInboxRequests.clear();
  for (const pending of pendingAiChatRequests.values()) {
    clearTimeout(pending.timeout);
  }
  pendingAiChatRequests.clear();
  for (const listener of accountListeners.values()) {
    listener.running = false;
    listener.redis.disconnect();
    listener.aiRedis.disconnect();
  }
  accountListeners.clear();
  desiredAccountListeners.clear();
  pinnedAccountListeners.clear();
  for (const supervisor of listenerSupervisors.values()) {
    supervisor.running = false;
  }
  listenerSupervisors.clear();
  ipcWorkerRunning = false;
}

/**
 * 暴露 AI Chat pending 请求表给单元测试断言。
 *
 * @returns 当前进程内的 AI Chat pending request Map。
 */
export function getPendingAiChatRequests(): Map<string, PendingInboxRequest> {
  return pendingAiChatRequests;
}

export function __getGlobalAgentConcurrencyStateForTests(): Promise<{
  activeKey: string;
  memberQueue: string;
  normalQueue: string;
  limit: number;
}> {
  return getAgentConcurrencyKeys();
}

export async function __peekNextGlobalAgentWaiterForTests(): Promise<
  string | null
> {
  return dequeueGlobalAgentWaiter();
}

/**
 * AI Chat 专属的入队函数。
 * 响应写入 `ipc:{accountId}:ai-chat:outbox`，永远不发微信。
 */
export function submitAiChatInboxRequest(
  input: AiChatSubmission,
): Promise<InboxRequestResult> {
  return submitAiChatRequest(input, pendingAiChatRequests, addAccountListener);
}

export type { AiChatSubmission } from './request-types.js';

export const __getPendingAiChatRequestsForTests = getPendingAiChatRequests;
