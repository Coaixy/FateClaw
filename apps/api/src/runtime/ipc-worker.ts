import { recordAgentTiming } from './agent-performance.js';
import { decodeRuntimeIpc, encodeRuntimeIpc } from './ipc-security.js';
import { InvalidRuntimeIpcError } from '@fateclaw/contracts/runtime-ipc';
import {
  acquireAgentExecution,
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

import { getUserByAccountId, getUserById } from '#infrastructure/db';
import { LOW_BALANCE_CONCURRENCY_THRESHOLD_COINS } from '#infrastructure/config';
import { processOutboxPayload } from './ipc-outbox-handler.js';
import { processAiChatOutboxPayload } from './ipc-ai-chat-outbox-handler.js';
import {
  getRuntimeEntitlementSnapshot,
  type RuntimeEntitlementSnapshot,
} from '#modules/billing/entitlements';

import {
  AGENT_REQUEST_TIMEOUT_MS as AGENT_REQUEST_TIMEOUT,
  AI_CHAT_REQUEST_TIMEOUT_MS as AI_CHAT_REQUEST_TIMEOUT,
  MAX_REQUEST_TIMEOUT_MS,
  SESSION_PROCESSING_LOCK_TTL_SECONDS,
} from '#shared/timeout-chain';

const GLOBAL_AGENT_GATE_POLL_MS = 500;
const IPC_LISTENER_RESTART_INITIAL_MS = 1_000;
const IPC_LISTENER_RESTART_MAX_MS = 30_000;
const IPC_LISTENER_STABLE_MS = 60_000;
import {
  InvalidAiChatPayloadError,
  buildAiChatErrorResponsePayload,
  type CancelInboxRequestPayload,
  claimOrRefreshSessionProcessingLock,
  InboxRequestResult,
  type LlmRuntimeSnapshot,
  PendingInboxRequest,
  releaseSessionProcessingLock,
  sessionProcessingLockKey,
} from './ipc-payloads.js';
import { logger } from '#infrastructure/logger';
import type { BillingReservation } from '#modules/billing/plans';
import {
  applyNonMemberPricingMarkup,
  reserveBillingForRequest,
  settleBillingReservationDetailed,
} from '#modules/billing/plans';
import { getRedis } from '#infrastructure/redis';
import {
  resolveUserLlmRuntime,
  type EffectiveLlmRuntimeConfig,
} from '#modules/system/system-config';
import {
  releaseLocalAgent,
  onLocalAgentProcessExit,
  type LocalAgentProcessExitInfo,
} from './local-runner.js';
import { FREE_WECHAT_UNSUPPORTED_MESSAGE } from '#modules/account/account-service';
import { getUserIdFromWebChatRuntimeId } from '#modules/chat/web-chat-runtime';
import type { User } from '#shared/types';
import {
  admitAgentRequest,
  markAgentRequestDispatched,
  requestAgentCancellation,
  persistAgentFailure,
} from '#infrastructure/repositories/agent-requests-repository';
import {
  tryAcquireBenefitExecutionSlot,
  ModelSelectionError,
} from '#infrastructure/repositories/benefit-repository';
export type { InboxRequestResult } from './ipc-payloads.js';

async function resolveLlmRuntimeSnapshot(
  userId: string,
): Promise<LlmRuntimeSnapshot> {
  const runtime = await resolveUserLlmRuntime(userId);
  return llmRuntimeToSnapshot(runtime);
}

function llmRuntimeToSnapshot(
  runtime: EffectiveLlmRuntimeConfig,
): LlmRuntimeSnapshot {
  return {
    poolKey: runtime.poolKey,
    poolRevision: runtime.poolRevision,
    benefitPolicy: runtime.benefitPolicy,
    benefitRequestId: runtime.benefitRequestId,
    source: runtime.source,
    billingMode: runtime.billingMode,
    modelConfigId: runtime.modelConfigId,
    piApi: runtime.piApi,
    model: runtime.model,
    contextWindowTokens: runtime.contextWindowTokens,
    maxOutputTokens: runtime.maxOutputTokens,
    thinkingLevel: runtime.thinkingLevel,
    apiKey: runtime.secret,
    baseUrl: runtime.baseUrl || undefined,
    authMode: runtime.authMode,
    providerKey: runtime.providerKey,
    poolNodes: runtime.poolNodes,
    inputTokenPricePerMillionCoins: runtime.inputTokenPricePerMillionCoins,
    outputTokenPricePerMillionCoins: runtime.outputTokenPricePerMillionCoins,
  };
}

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

function resolveInboxPriority(
  entitlement: RuntimeEntitlementSnapshot,
): 'member' | 'normal' {
  return entitlement.hasPriorityQueue ? 'member' : 'normal';
}

function entitlementMetadata(snapshot: RuntimeEntitlementSnapshot) {
  return {
    membershipActive: snapshot.membershipActive,
    availableCoins: snapshot.wallet.availableCoins,
    wallet: {
      purchased_coins: snapshot.wallet.purchasedCoins,
      bonus_coins: snapshot.wallet.bonusCoins,
      reserved_coins: snapshot.wallet.reservedCoins,
      inArrears: snapshot.wallet.inArrears,
    },
  };
}

async function enqueueInboxPayload(
  accountId: string,
  priority: 'member' | 'normal',
  payload: string,
) {
  const key =
    priority === 'member'
      ? `ipc:${accountId}:inbox:member`
      : `ipc:${accountId}:inbox`;
  await getRedis().lpush(
    key,
    encodeRuntimeIpc(accountId, key, payload, MAX_REQUEST_TIMEOUT_MS),
  );
}

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

// ---------------------------------------------------------------------------
// per-user 余额感知 metered 并发门
//
// 洞：入口只挡 inArrears（余额<0）、不冻结、不限并发；余额≈0 的会员可开多 session
// 几乎同时发请求，全部放行各自赊账，负债 = 单请求成本 × min(session 数, 全局上限)。
// 修法：低余额用户（availableCoins < 阈值）同一时刻只允许 1 个 metered 请求在跑——
// 那 1 个跑完进入欠费后，后续请求被入口 inArrears 挡住，故最坏赊账锁到「1 个请求」。
// 健康余额用户不进入此门，沿用全局并发上限，零额外开销。
//
// 计数用 per-user ZSET（member=requestId, score=now），acquire 时 ZREMRANGEBYSCORE
// 自动剪除超时窗口外的陈旧项 → 漏释放最多卡一个窗口；再配 PEXPIRE 兜底键过期。
// 释放点（全局槽的各个 release 处）拿不到 userId，故用 requestId→userId 反查键，
// 释放只凭 requestId 即可定位，未 gate 的请求查不到 → 空操作。
// ---------------------------------------------------------------------------
const PER_USER_METERED_ZKEY_PREFIX = 'agent:user-metered:z:';
const PER_USER_METERED_OWNER_PREFIX = 'agent:user-metered:o:';
// 含「积分不足」关键词，chat-session-service 据此映射为 402（见 isPaymentRequiredError）。
const LOW_BALANCE_CONCURRENCY_MESSAGE =
  '积分不足以同时进行多个解读，请等当前解读完成或充值后再试';

function perUserMeteredZKey(userId: string): string {
  return `${PER_USER_METERED_ZKEY_PREFIX}${userId}`;
}
function perUserMeteredOwnerKey(requestId: string): string {
  return `${PER_USER_METERED_OWNER_PREFIX}${requestId}`;
}

/**
 * 尝试为低余额用户领取一个 per-user metered 在途名额。
 *
 * @returns 名额未满则占用并返回 true；已达上限返回 false（调用方应拒绝该请求）。
 * @remarks 仅对低余额 metered 请求调用；陈旧项按超时窗口自动剪除，避免漏释放永久锁死。
 */
async function tryAcquirePerUserMeteredSlot(input: {
  userId: string;
  requestId: string;
  limit: number;
}): Promise<boolean> {
  const now = Date.now();
  // 超时窗口：取两类请求超时的较大值，确保不会把仍可能在途的请求误剪。
  const staleMs = MAX_REQUEST_TIMEOUT_MS;
  const acquired = await getRedis().eval(
    `
    redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[3])
    if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then
      return 0
    end
    redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
    redis.call('PEXPIRE', KEYS[1], ARGV[5])
    return 1
    `,
    1,
    perUserMeteredZKey(input.userId),
    input.limit,
    now,
    now - staleMs,
    input.requestId,
    staleMs,
  );
  if (acquired === 1) {
    // 反查键：释放点只有 requestId，借此定位 userId。带 TTL 兜底漏释放。
    await getRedis().set(
      perUserMeteredOwnerKey(input.requestId),
      input.userId,
      'PX',
      staleMs,
    );
    return true;
  }
  return false;
}

/**
 * 释放某请求占用的 per-user metered 名额（只凭 requestId）。
 *
 * @remarks 幂等：未 gate 或已释放的请求查不到反查键 → 直接返回，无副作用；
 *          可在所有全局槽释放点无条件调用，对非 gated（含微信）请求是空操作。
 *          导出供 inbox-stall-sweeper 在代消费无主 outbox 响应时释放对应名额。
 */
export async function releasePerUserMeteredSlotByRequestId(
  requestId?: string,
): Promise<void> {
  if (!requestId) return;
  const ownerKey = perUserMeteredOwnerKey(requestId);
  const userId = await getRedis().get(ownerKey);
  if (!userId) return;
  await getRedis().zrem(perUserMeteredZKey(userId), requestId);
  await getRedis().del(ownerKey);
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

async function releaseLocalAgentLeaseById(
  leaseId: string | undefined,
  context: { accountId?: string; requestId?: string; reason: string },
): Promise<void> {
  if (!leaseId) return;
  await releaseLocalAgent(leaseId).catch((err) => {
    logger.warn(
      {
        accountId: context.accountId,
        leaseId,
        requestId: context.requestId,
        reason: context.reason,
        err,
      },
      '释放本地 agent-runtime 租约失败',
    );
  });
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

async function getOwnerByRuntimeId(
  runtimeId: string,
): Promise<User | undefined> {
  const webUserId = getUserIdFromWebChatRuntimeId(runtimeId);
  return webUserId ? getUserById(webUserId) : getUserByAccountId(runtimeId);
}

/**
 * 判断指定账号当前是否还有等待响应的在途请求（微信或 AI Chat 任一）。
 *
 * @param accountId 运行时账号 ID。
 * @returns 存在在途请求时返回 true。
 */
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
  const redis = getRedis().duplicate({ commandTimeout: 0 });
  const aiRedis = getRedis().duplicate({ commandTimeout: 0 });
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
          : await redis.brpop(queueName, 1);

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
          if (queue.endsWith(':ai-chat:outbox')) {
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

export function submitInboxRequest(input: {
  accountId: string;
  type: 'chat' | 'task';
  userMessage: string;
  history: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp?: string;
  }>;
  toUserId?: string;
  contextToken?: string;
  autoDeliver?: boolean;
  sessionId?: string;
  userName?: string;
  assistantName?: string;
  llmRuntime?: EffectiveLlmRuntimeConfig;
}): Promise<InboxRequestResult> {
  const requestId = `inbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise<InboxRequestResult>((resolve, reject) => {
    void (async () => {
      let timeout: NodeJS.Timeout | null = null;
      let billingReservation: BillingReservation | null = null;
      let concurrencySlotId: string | undefined;
      let localAgentLeaseId: string | undefined;

      try {
        const owner = await getOwnerByRuntimeId(input.accountId);
        if (!owner?.id) {
          // 未绑定平台用户的账号不应消费 token：拒绝并明确日志，避免无追踪计费泄漏。
          logger.warn(
            { accountId: input.accountId, type: input.type },
            '收件箱请求被拒绝：账号未绑定到平台用户',
          );
          reject(new Error('账号未绑定平台用户，无法处理 AI 请求'));
          return;
        }
        const entitlement = await getRuntimeEntitlementSnapshot(owner.id);
        const priority = resolveInboxPriority(entitlement);
        if ((input.autoDeliver ?? true) && !entitlement.canUseWechatClaw) {
          reject(new Error(FREE_WECHAT_UNSUPPORTED_MESSAGE));
          return;
        }
        const baseRuntime = input.llmRuntime
          ? llmRuntimeToSnapshot(input.llmRuntime)
          : await resolveLlmRuntimeSnapshot(owner.id);
        // 非会员专家模式加价：把官方模型 token 单价烙进快照，贯穿 reserve/settle/recover。
        const llmRuntime = applyNonMemberPricingMarkup(
          baseRuntime,
          entitlement.membershipActive,
        );
        billingReservation = await reserveBillingForRequest({
          userId: owner.id,
          requestId,
          runtime: llmRuntime,
          entitlementSnapshot: entitlementMetadata(entitlement),
        });

        timeout = setTimeout(async () => {
          // 超时时清除会话忙碌标记
          const pending = pendingInboxRequests.get(requestId);
          const sessionId = pending?.sessionId;
          pendingInboxRequests.delete(requestId);
          if (sessionId) {
            void releaseSessionProcessingLock(sessionId, requestId).catch(
              () => {},
            );
          }
          void releaseGlobalAgentSlot(
            pending?.concurrencySlotId ?? concurrencySlotId ?? requestId,
          );
          void releasePerUserMeteredSlotByRequestId(requestId);
          void releaseLocalAgentLeaseForPending(pending, {
            accountId: input.accountId,
            requestId,
            reason: 'timeout',
          });
          logger.error(
            { accountId: input.accountId, requestId, type: input.type },
            '收件箱请求超时',
          );
          reject(new Error(`收件箱请求超时: ${requestId}`));
        }, AGENT_REQUEST_TIMEOUT);

        pendingInboxRequests.set(requestId, {
          accountId: input.accountId,
          ownerUserId: owner.id,
          toUserId: input.toUserId,
          contextToken: input.contextToken,
          autoDeliver: input.autoDeliver ?? true,
          sessionId: input.sessionId,
          sessionProcessingRequestId: input.sessionId ? requestId : undefined,
          llmRuntime,
          billingReservation,
          priority,
          concurrencySlotId,
          localAgentLeaseId,
          resolve,
          reject,
          timeout,
        });

        concurrencySlotId = await acquireAgentExecution({
          accountId: input.accountId,
          deadlineAtMs: Date.now() + AGENT_REQUEST_TIMEOUT,
          onRuntimeReady: (leaseId, capacityToken) => {
            const pending = pendingInboxRequests.get(requestId);
            if (!pending) return false;
            localAgentLeaseId = leaseId;
            pending.localAgentLeaseId = leaseId;
            pending.capacityToken = capacityToken;
            return true;
          },
          requestId,
          priority,
          shouldContinue: () => pendingInboxRequests.has(requestId),
          onAcquired: (slotId) => {
            concurrencySlotId = slotId;
            const pending = pendingInboxRequests.get(requestId);
            if (pending) {
              pending.concurrencySlotId = slotId;
            }
          },
        });
        if (!pendingInboxRequests.has(requestId)) {
          throw new Error('请求已取消或超时');
        }

        const payload = JSON.stringify({
          type: input.type,
          requestId,
          accountId: input.accountId,
          userMessage: input.userMessage,
          history: input.history,
          sessionId: input.sessionId,
          userName: input.userName,
          assistantName: input.assistantName,
          llmRuntime,
          timestamp: new Date().toISOString(),
        });

        // 写入会话忙碌标记（35 分钟 TTL，比 agent 超时 30min 多 5min 做缓冲）
        if (input.sessionId) {
          const processingClaimed = await claimOrRefreshSessionProcessingLock(
            input.sessionId,
            requestId,
            SESSION_PROCESSING_LOCK_TTL_SECONDS,
          );
          if (!processingClaimed) {
            throw new Error('会话正在处理其他请求');
          }
        }

        const pending = pendingInboxRequests.get(requestId);
        if (!pending) {
          throw new Error('请求已取消或超时');
        }
        await enqueueInboxPayload(
          input.accountId,
          pending.priority ?? 'normal',
          payload,
        );
        logger.info(
          {
            accountId: input.accountId,
            requestId,
            type: input.type,
            autoDeliver: input.autoDeliver ?? true,
            toUserId: input.toUserId,
            billingRecorded: Boolean(billingReservation),
            priority: pending.priority ?? 'normal',
            concurrencySlotId,
          },
          '已提交收件箱请求到 Redis',
        );
      } catch (err) {
        if (timeout) {
          clearTimeout(timeout);
        }
        const pending = pendingInboxRequests.get(requestId);
        pendingInboxRequests.delete(requestId);
        if (input.sessionId) {
          void releaseSessionProcessingLock(input.sessionId, requestId).catch(
            () => {},
          );
        }
        void releaseGlobalAgentSlot(concurrencySlotId ?? requestId);
        if (pending) {
          void releaseLocalAgentLeaseForPending(pending, {
            accountId: input.accountId,
            requestId,
            reason: 'submit_error',
          });
        } else {
          void releaseLocalAgentLeaseById(localAgentLeaseId, {
            accountId: input.accountId,
            requestId,
            reason: 'submit_error',
          });
        }
        reject(
          err instanceof Error
            ? err
            : new Error(`写入 Redis 收件箱失败: ${String(err)}`),
        );
      }
    })();
  });
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

  // 一次性清理旧版 LIST 等待队列残留：等待队列已迁移为 ZSET（key 名不同，避免
  // WRONGTYPE），旧 LIST 里的 requestId 全部属于已死进程，直接删除即可。
  void getRedis()
    .del('agent:concurrency:wait:member', 'agent:concurrency:wait:normal')
    .catch((err) => {
      logger.warn({ err }, '清理旧版并发等待队列残留失败（不影响运行）');
    });

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

export function __getGlobalAgentConcurrencyStateForTests(): {
  activeKey: string;
  memberQueue: string;
  normalQueue: string;
  limit: number;
} {
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
  const requestId =
    input.requestId ??
    `aichat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAtMs = Date.now();
  const aiChatOutboxQueue = `ipc:${input.accountId}:ai-chat:outbox`;
  let acceptedEarly = false;
  let payloadQueued = false;
  let payloadEnqueueAttempted = false;
  let executionId = input.recoveryExecutionId;
  let admissionRuntime: LlmRuntimeSnapshot | undefined;
  const deadlineAtMs = input.recoveryDeadlineAt
    ? Date.parse(input.recoveryDeadlineAt)
    : startedAtMs + AI_CHAT_REQUEST_TIMEOUT;

  return new Promise<InboxRequestResult>((resolve, reject) => {
    void (async () => {
      let timeout: NodeJS.Timeout | null = null;
      let billingReservation: BillingReservation | null = null;
      let concurrencySlotId: string | undefined;
      let localAgentLeaseId: string | undefined;

      try {
        const ownerUserId =
          input.entitlementSnapshot?.userId ??
          (await getOwnerByRuntimeId(input.accountId))?.id;
        if (!ownerUserId) {
          // 未绑定平台用户的账号不应消费 token：拒绝并明确日志，避免无追踪计费泄漏。
          logger.warn(
            { accountId: input.accountId, kind: 'ai-chat' },
            '收件箱请求被拒绝：账号未绑定到平台用户',
          );
          reject(new Error('账号未绑定平台用户，无法处理 AI 请求'));
          return;
        }
        const baseRuntime = input.llmRuntime
          ? llmRuntimeToSnapshot(input.llmRuntime)
          : await resolveLlmRuntimeSnapshot(ownerUserId);
        if (baseRuntime.poolKey === 'benefit')
          baseRuntime.benefitRequestId = requestId;
        const entitlement =
          input.entitlementSnapshot ??
          (await getRuntimeEntitlementSnapshot(ownerUserId));
        // 非会员专家模式加价：把官方模型 token 单价烙进快照，贯穿 reserve/settle/recover。
        const llmRuntime = applyNonMemberPricingMarkup(
          baseRuntime,
          entitlement.membershipActive,
        );

        admissionRuntime = llmRuntime;
        // per-user 余额感知并发门：低余额用户同一时刻只允许 1 个 metered 请求在跑，
        // 封住「多 session 并发把余额刷成大额欠费」的白嫖。健康余额用户不进入此门。
        // 置于一切资源分配（预留/定时器/pending/槽位）之前——被拒时无需任何清理。
        if (
          llmRuntime.billingMode === 'metered' &&
          entitlement.wallet.availableCoins <
            LOW_BALANCE_CONCURRENCY_THRESHOLD_COINS
        ) {
          const slotAcquired = await tryAcquirePerUserMeteredSlot({
            userId: ownerUserId,
            requestId,
            limit: 1,
          });
          if (!slotAcquired) {
            logger.info(
              {
                accountId: input.accountId,
                ownerUserId,
                requestId,
                availableCoins: entitlement.wallet.availableCoins,
              },
              'AI Chat 低余额用户已有 metered 请求在跑，拒绝并发新请求',
            );
            reject(new Error(LOW_BALANCE_CONCURRENCY_MESSAGE));
            return;
          }
        }

        billingReservation = await reserveBillingForRequest({
          userId: ownerUserId,
          requestId,
          runtime: llmRuntime,
          entitlementSnapshot: entitlementMetadata(entitlement),
        });
        const priority = resolveInboxPriority(entitlement);
        executionId ??= await admitAgentRequest({
          input: { ...input, entitlementSnapshot: entitlement },
          requestId,
          ownerUserId,
          runtime: baseRuntime,
          deadlineAt: deadlineAtMs,
        });

        timeout = setTimeout(
          async () => {
            void requestAgentCancellation(requestId).catch((err) => {
              logger.error(
                { requestId, err },
                'Failed to persist request timeout cancellation',
              );
            });
            const pending = pendingAiChatRequests.get(requestId);
            pendingAiChatRequests.delete(requestId);
            // 清除当前请求持有的会话忙碌标记，避免误删后续请求的锁。
            void releaseSessionProcessingLock(input.sessionId, requestId).catch(
              () => {},
            );
            void releaseGlobalAgentSlot(
              pending?.concurrencySlotId ?? concurrencySlotId ?? requestId,
            );
            void releasePerUserMeteredSlotByRequestId(requestId);
            void releaseLocalAgentLeaseForPending(pending, {
              accountId: input.accountId,
              requestId,
              reason: 'timeout',
            });
            logger.error(
              {
                accountId: input.accountId,
                requestId,
                sessionId: input.sessionId,
              },
              'AI Chat 请求超时',
            );
            reject(new Error(`AI Chat 请求超时: ${requestId}`));
          },
          Math.max(1, deadlineAtMs - Date.now()),
        );

        pendingAiChatRequests.set(requestId, {
          accountId: input.accountId,
          ownerUserId,
          toUserId: undefined,
          contextToken: undefined,
          autoDeliver: false, // AI Chat 永远不发微信
          sessionId: input.sessionId,
          userMessageId: input.userMessageId,
          sessionProcessingRequestId: requestId,
          llmRuntime,
          billingReservation,
          startedAtMs,
          timings: [
            {
              type: 'agent_timing',
              stage: 'admission',
              durationMs: Date.now() - startedAtMs,
            },
          ],
          priority,
          concurrencySlotId,
          resolve,
          reject,
          timeout,
        });
        recordAgentTiming('admission', Date.now() - startedAtMs);
        if (input.waitForResponse === false) {
          acceptedEarly = true;
          resolve({ requestId, status: 'success', text: '' });
        }
        concurrencySlotId = await acquireAgentExecution({
          requestId,
          accountId: input.accountId,
          priority,
          deadlineAtMs,
          beforeGlobal: async () => {
            if (llmRuntime.poolKey === 'benefit') {
              while (!(await tryAcquireBenefitExecutionSlot(requestId))) {
                if (
                  !pendingAiChatRequests.has(requestId) ||
                  Date.now() >= deadlineAtMs
                )
                  throw new Error(
                    '免费服务繁忙，请稍后重试。本次未扣免费次数。',
                  );
                await new Promise<void>((done) =>
                  setTimeout(done, GLOBAL_AGENT_GATE_POLL_MS),
                );
              }
            }
          },
          onTiming: (stage, durationMs) => {
            recordAgentTiming(stage, durationMs);
            pendingAiChatRequests
              .get(requestId)
              ?.timings?.push({ type: 'agent_timing', stage, durationMs });
          },
          shouldContinue: () =>
            pendingAiChatRequests.has(requestId) && Date.now() < deadlineAtMs,
          onRuntimeReady: (leaseId, capacityToken) => {
            const pending = pendingAiChatRequests.get(requestId);
            if (!pending) return false;
            localAgentLeaseId = leaseId;
            pending.localAgentLeaseId = leaseId;
            pending.capacityToken = capacityToken;
            addAccountListener(input.accountId);
            return true;
          },
          onAcquired: (slotId) => {
            concurrencySlotId = slotId;
            const pending = pendingAiChatRequests.get(requestId);
            if (pending) pending.concurrencySlotId = slotId;
          },
        });
        if (!pendingAiChatRequests.has(requestId))
          throw new Error('请求已取消或超时');

        const payload = JSON.stringify({
          type: 'chat',
          requestId,
          executionId,
          accountId: input.accountId,
          userMessage: input.userMessage,
          inputKind: input.inputKind,
          pastedBoard: input.pastedBoard,
          history: input.history,
          sessionBoardContexts: input.sessionBoardContexts,
          piSessionBase: input.piSessionBase,
          acceptedAtMs: startedAtMs,
          sessionId: input.sessionId,
          userMessageId: input.userMessageId,
          ownerUserId,
          userName: input.userName,
          assistantName: input.assistantName,
          personaPrompt: input.personaPrompt,
          authorizedSkillIds: input.authorizedSkillIds,
          llmRuntime,
          timestamp: new Date().toISOString(),
          outboxQueue: aiChatOutboxQueue, // 指定响应队列
        });

        // chat-session-service 已用同一个 requestId 预抢占锁；这里仅续期自有锁，避免旧请求覆盖新 owner。
        const processingClaimed = await claimOrRefreshSessionProcessingLock(
          input.sessionId,
          requestId,
          SESSION_PROCESSING_LOCK_TTL_SECONDS, // 从超时链派生（API 超时 + 5 分钟缓冲）
        );
        if (!processingClaimed) {
          throw new Error('会话正在处理其他请求');
        }

        const pending = pendingAiChatRequests.get(requestId);
        if (!pending) {
          throw new Error('请求已取消或超时');
        }
        if (!(await markAgentRequestDispatched(requestId))) {
          throw new Error('Request cancelled, expired, or claimed by recovery');
        }
        payloadEnqueueAttempted = true;
        await enqueueInboxPayload(
          input.accountId,
          pending.priority ?? 'normal',
          payload,
        );
        payloadQueued = true;
        logger.info(
          {
            accountId: input.accountId,
            requestId,
            sessionId: input.sessionId,
            outboxQueue: aiChatOutboxQueue,
            billingRecorded: Boolean(billingReservation),
            priority: pending.priority ?? 'normal',
            concurrencySlotId,
          },
          'AI Chat 请求已提交到 Redis',
        );
      } catch (err) {
        let submissionFailure: unknown = null;
        if (
          err instanceof ModelSelectionError &&
          !executionId &&
          billingReservation &&
          admissionRuntime
        ) {
          // A selection conflict occurs before admission or dispatch; its zero-usage reservation can close immediately.
          try {
            await settleBillingReservationDetailed({
              requestId,
              runtime: admissionRuntime,
              promptTokens: 0,
              completionTokens: 0,
            });
          } catch (error) {
            logger.error(
              { requestId, err: error },
              'Failed to close undispatched billing reservation',
            );
          }
        }
        if (executionId && !payloadQueued) {
          submissionFailure = await persistAgentFailure(
            requestId,
            buildAiChatErrorResponsePayload({
              accountId: input.accountId,
              requestId,
              sessionId: input.sessionId,
              userMessageId: input.userMessageId,
              ownerUserId: input.entitlementSnapshot?.userId,
              publicErrorText: '抱歉，AI 服务暂时不可用',
              error: 'Request submission interrupted',
              reasonCode: 'submit_error',
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            }),
          ).catch((failure) =>
            logger.error(
              { requestId, err: failure },
              'Failed to persist submission failure',
            ),
          );
        }
        // 占用的 per-user metered 名额在任何失败分支都要释放,否则低余额用户会被永久卡住。
        await releasePerUserMeteredSlotByRequestId(requestId).catch(() => {});
        if (acceptedEarly && !payloadQueued) {
          if (!submissionFailure) {
            const pending = pendingAiChatRequests.get(requestId);
            if (!payloadEnqueueAttempted && pending) {
              if (pending.capacityToken)
                await releaseGlobalAgentSlot(
                  requestId,
                  pending.capacityToken,
                ).catch(() => {});
              await releaseLocalAgentLeaseForPending(pending, {
                accountId: input.accountId,
                requestId,
                reason: 'undispatched_submission_failure',
              });
              clearTimeout(pending.timeout);
              pendingAiChatRequests.delete(requestId);
            }
            return;
          }
          await releaseGlobalAgentSlot(concurrencySlotId ?? requestId);
          const pending = pendingAiChatRequests.get(requestId);
          if (pending) {
            await processAiChatOutboxPayload(
              submissionFailure,
              input.accountId,
              pendingAiChatRequests,
            ).catch((handlerErr) => {
              clearTimeout(pending.timeout);
              pendingAiChatRequests.delete(requestId);
              void releaseSessionProcessingLock(
                input.sessionId,
                requestId,
              ).catch(() => {});
              void releaseLocalAgentLeaseForPending(pending, {
                accountId: input.accountId,
                requestId,
                reason: 'submit_error_fallback',
              });
              logger.error(
                { accountId: input.accountId, requestId, err: handlerErr },
                'AI Chat 入队失败后的错误消息落库失败',
              );
            });
          }
          return;
        }
        if (timeout) {
          clearTimeout(timeout);
        }
        const pending = pendingAiChatRequests.get(requestId);
        pendingAiChatRequests.delete(requestId);
        void releaseSessionProcessingLock(input.sessionId, requestId).catch(
          () => {},
        );
        void releaseGlobalAgentSlot(concurrencySlotId ?? requestId);
        if (pending) {
          void releaseLocalAgentLeaseForPending(pending, {
            accountId: input.accountId,
            requestId,
            reason: 'submit_error',
          });
        } else {
          void releaseLocalAgentLeaseById(localAgentLeaseId, {
            accountId: input.accountId,
            requestId,
            reason: 'submit_error',
          });
        }
        reject(
          err instanceof Error
            ? err
            : new Error(`写入 Redis 收件箱失败: ${String(err)}`),
        );
      }
    })().catch(reject);
  });
}

export type { AiChatSubmission } from './request-types.js';

export const __getPendingAiChatRequestsForTests = getPendingAiChatRequests;
