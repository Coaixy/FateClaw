/**
 * IPC 工作线程：Redis BRPOP 监听 + 收件箱请求管理。
 * 具体的 outbox 消息处理逻辑拆分到各自的 handler 模块。
 */

import { Redis } from 'ioredis';

import { getUserByAccountId, getUserById } from '../infrastructure/db.js';
import { LOW_BALANCE_CONCURRENCY_THRESHOLD_COINS } from '../infrastructure/config.js';
import { processOutboxPayload } from './ipc-outbox-handler.js';
import { processAiChatOutboxPayload } from './ipc-ai-chat-outbox-handler.js';
import {
  getRuntimeEntitlementSnapshot,
  type RuntimeEntitlementSnapshot,
} from '../modules/billing/entitlements.js';

/** Agent 请求超时时间（默认 30 分钟） */
const AGENT_REQUEST_TIMEOUT = parseInt(
  process.env.AGENT_REQUEST_TIMEOUT || '1800000',
  10,
);
const DEFAULT_GLOBAL_AGENT_CONCURRENCY_LIMIT = Math.max(
  1,
  parseInt(process.env.AGENT_CONCURRENCY_LIMIT || '10', 10) || 10,
);
const GLOBAL_AGENT_CONCURRENCY_KEY = 'agent:concurrency:active';
const GLOBAL_AGENT_MEMBER_WAIT_QUEUE = 'agent:concurrency:wait:member';
const GLOBAL_AGENT_NORMAL_WAIT_QUEUE = 'agent:concurrency:wait:normal';
const GLOBAL_AGENT_GATE_POLL_MS = 500;
const GLOBAL_AGENT_LIMIT_CACHE_MS = 2_000;
const IPC_LISTENER_RESTART_INITIAL_MS = 1_000;
const IPC_LISTENER_RESTART_MAX_MS = 30_000;
const IPC_LISTENER_STABLE_MS = 60_000;
import {
  type CancelInboxRequestPayload,
  claimOrRefreshSessionProcessingLock,
  InboxRequestResult,
  type LlmRuntimeSnapshot,
  PendingInboxRequest,
  releaseSessionProcessingLock,
  sessionProcessingLockKey,
} from './ipc-payloads.js';
import { logger } from '../infrastructure/logger.js';
import type { BillingReservation } from '../modules/billing/plans.js';
import { reserveBillingForRequest } from '../modules/billing/plans.js';
import { getRedis } from '../infrastructure/redis.js';
import {
  getAgentConcurrencyLimit,
  resolveUserLlmRuntime,
  type EffectiveLlmRuntimeConfig,
} from '../modules/system/system-config.js';
import {
  ensureLocalAgentRunning,
  releaseLocalAgent,
  retainLocalAgent,
} from './local-runner.js';
import { FREE_WECHAT_UNSUPPORTED_MESSAGE } from '../modules/account/account-service.js';
import { getUserIdFromWebChatRuntimeId } from '../modules/chat/web-chat-runtime.js';
import type { User } from '../shared/types.js';
import type {
  HistoryMessage,
  SessionBoardContext,
} from '../shared/token-budget.js';

type ChatInputKind = 'normal' | 'user_pasted_board';

interface UserPastedBoardInput {
  category: string;
  content: string;
  question: string;
}

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
    inputTokenPricePerMillionCoins: runtime.inputTokenPricePerMillionCoins,
    outputTokenPricePerMillionCoins: runtime.outputTokenPricePerMillionCoins,
  };
}

let ipcWorkerRunning = false;
const pendingInboxRequests = new Map<string, PendingInboxRequest>();
/** AI Chat 专属的 pending 请求 Map（完全隔离） */
const pendingAiChatRequests = new Map<string, PendingInboxRequest>();
const accountListeners = new Map<string, { running: boolean; redis: Redis }>();
const desiredAccountListeners = new Set<string>();
const listenerSupervisors = new Map<string, { running: boolean }>();
let cachedGlobalAgentConcurrencyLimit: {
  value: number;
  expiresAtMs: number;
} | null = null;

function resolveInboxPriority(
  entitlement: RuntimeEntitlementSnapshot,
): 'member' | 'normal' {
  return entitlement.hasPriorityQueue ? 'member' : 'normal';
}

function entitlementMetadata(snapshot: RuntimeEntitlementSnapshot) {
  return {
    planKey: snapshot.planKey,
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
  await getRedis().lpush(key, payload);
}

async function resolveGlobalAgentConcurrencyLimit(): Promise<number> {
  if (
    cachedGlobalAgentConcurrencyLimit &&
    cachedGlobalAgentConcurrencyLimit.expiresAtMs > Date.now()
  ) {
    return cachedGlobalAgentConcurrencyLimit.value;
  }
  try {
    const value = await getAgentConcurrencyLimit();
    cachedGlobalAgentConcurrencyLimit = {
      value,
      expiresAtMs: Date.now() + GLOBAL_AGENT_LIMIT_CACHE_MS,
    };
    return value;
  } catch (err) {
    logger.warn({ err }, '读取后台 agent 并发上限失败，使用环境变量默认值');
    return DEFAULT_GLOBAL_AGENT_CONCURRENCY_LIMIT;
  }
}

async function tryAcquireQueuedGlobalAgentSlot(input: {
  requestId: string;
  limit: number;
}): Promise<{ acquired: boolean; reason: string }> {
  const result = await getRedis().eval(
    `
    redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[3])
    if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then
      return {0, 'busy'}
    end
    local memberTail = redis.call('LINDEX', KEYS[2], -1)
    if memberTail then
      if memberTail ~= ARGV[4] then
        return {0, 'not_turn'}
      end
      redis.call('RPOP', KEYS[2])
      redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
      return {1, 'member'}
    end
    local normalTail = redis.call('LINDEX', KEYS[3], -1)
    if normalTail then
      if normalTail ~= ARGV[4] then
        return {0, 'not_turn'}
      end
      redis.call('RPOP', KEYS[3])
      redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
      return {1, 'normal'}
    end
    return {0, 'missing'}
    `,
    3,
    GLOBAL_AGENT_CONCURRENCY_KEY,
    GLOBAL_AGENT_MEMBER_WAIT_QUEUE,
    GLOBAL_AGENT_NORMAL_WAIT_QUEUE,
    input.limit,
    Date.now(),
    Date.now() - Math.max(AGENT_REQUEST_TIMEOUT, AI_CHAT_REQUEST_TIMEOUT),
    input.requestId,
  );
  if (Array.isArray(result)) {
    return {
      acquired: result[0] === 1,
      reason: typeof result[1] === 'string' ? result[1] : 'unknown',
    };
  }
  if (result === 1) {
    return { acquired: true, reason: 'legacy_success' };
  }
  return { acquired: false, reason: 'unknown' };
}

function waitQueueForPriority(priority: 'member' | 'normal'): string {
  return priority === 'member'
    ? GLOBAL_AGENT_MEMBER_WAIT_QUEUE
    : GLOBAL_AGENT_NORMAL_WAIT_QUEUE;
}

async function dequeueGlobalAgentWaiter(): Promise<string | null> {
  return (
    (await getRedis().lindex(GLOBAL_AGENT_MEMBER_WAIT_QUEUE, -1)) ??
    (await getRedis().lindex(GLOBAL_AGENT_NORMAL_WAIT_QUEUE, -1))
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

/**
 * 领取全站 agent 并发槽位。会员进入独立等待队列，槽位释放时优先唤醒会员。
 */
async function acquireGlobalAgentSlot(input: {
  requestId: string;
  priority: 'member' | 'normal';
  shouldContinue?: () => boolean;
  onQueued?: () => void;
  onAcquired?: (slotId: string) => void;
}): Promise<string> {
  const queue = waitQueueForPriority(input.priority);
  const assertActive = () => {
    if (input.shouldContinue && !input.shouldContinue()) {
      throw new Error('请求已取消或超时');
    }
  };
  assertActive();
  await getRedis().lpush(queue, input.requestId);
  input.onQueued?.();
  try {
    while (true) {
      assertActive();
      const acquired = await tryAcquireQueuedGlobalAgentSlot({
        requestId: input.requestId,
        limit: await resolveGlobalAgentConcurrencyLimit(),
      });
      if (acquired.acquired) {
        input.onAcquired?.(input.requestId);
        try {
          assertActive();
        } catch (err) {
          await releaseGlobalAgentSlot(input.requestId);
          throw err;
        }
        return input.requestId;
      }
      await delay(GLOBAL_AGENT_GATE_POLL_MS);
    }
  } catch (err) {
    await getRedis()
      .lrem(queue, 0, input.requestId)
      .catch(() => {
        // 等待队列清理失败不应覆盖原始入队/抢占错误。
      });
    throw err;
  }
}

export async function releaseGlobalAgentSlot(slotId?: string): Promise<void> {
  if (!slotId) return;
  await getRedis().zrem(GLOBAL_AGENT_CONCURRENCY_KEY, slotId);
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
  const staleMs = Math.max(AGENT_REQUEST_TIMEOUT, AI_CHAT_REQUEST_TIMEOUT);
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
 */
async function releasePerUserMeteredSlotByRequestId(
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

async function releaseLocalAgentLeaseByAccountId(
  leaseAccountId: string | undefined,
  context: { accountId?: string; requestId?: string; reason: string },
): Promise<void> {
  if (!leaseAccountId) return;
  await releaseLocalAgent(leaseAccountId).catch((err) => {
    logger.warn(
      {
        accountId: context.accountId ?? leaseAccountId,
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

  if (pending) {
    clearTimeout(pending.timeout);
    pendingAiChatRequests.delete(requestId);
  }
  await releaseSessionProcessingLock(sessionId, requestId);
  await releaseGlobalAgentSlot(pending?.concurrencySlotId);
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
    buildAiChatCancelPayload({
      requestId,
      accountId: runtimeAccountId,
      sessionId,
      reason,
    }),
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
 * 为单个 account 启动 BRPOP 监听协程。
 */
async function listenForAccount(accountId: string): Promise<void> {
  const redis = getRedis().duplicate();
  const listener = { running: true, redis };
  accountListeners.set(accountId, listener);

  logger.info({ accountId }, '启动 Redis IPC 监听');

  try {
    while (listener.running) {
      const result = await redis.brpop(
        `ipc:${accountId}:outbox`,
        `ipc:${accountId}:ai-chat:outbox`, // AI Chat 专属队列
        1, // 1s 超时，允许优雅退出
      );

      if (!result) continue;

      const [queue, raw] = result;

      try {
        const payload = JSON.parse(raw) as unknown;
        try {
          if (queue.endsWith(':ai-chat:outbox')) {
            // AI Chat 专属队列：永远不发微信
            await processAiChatOutboxPayload(
              payload,
              accountId,
              pendingAiChatRequests,
            );
          } else if (queue.endsWith(':outbox')) {
            await processOutboxPayload(
              payload,
              accountId,
              pendingInboxRequests,
            );
          }
        } finally {
          await releaseGlobalAgentSlotForPayload(queue, payload).catch(
            (err) => {
              logger.warn({ accountId, queue, err }, '释放 agent 并发槽位失败');
            },
          );
        }
      } catch (error) {
        logger.error(
          { accountId, queue, err: error },
          '处理 Redis IPC 消息失败',
        );

        // 兜底：如果 outbox response 处理失败且 pending 仍未被 resolve，在此清理
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
  } finally {
    await redis.quit();
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
      let localAgentLeaseAccountId: string | undefined;

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
        const llmRuntime = input.llmRuntime
          ? llmRuntimeToSnapshot(input.llmRuntime)
          : await resolveLlmRuntimeSnapshot(owner.id);
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
            pending?.concurrencySlotId ?? concurrencySlotId,
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

        localAgentLeaseAccountId = retainLocalAgent(input.accountId);
        if (!localAgentLeaseAccountId) {
          throw new Error('本地 agent-runtime 未启动或已退出，请稍后重试');
        }
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
          localAgentLeaseAccountId,
          resolve,
          reject,
          timeout,
        });

        concurrencySlotId = await acquireGlobalAgentSlot({
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
            2100,
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
        void releaseGlobalAgentSlot(concurrencySlotId);
        if (pending) {
          void releaseLocalAgentLeaseForPending(pending, {
            accountId: input.accountId,
            requestId,
            reason: 'submit_error',
          });
        } else {
          void releaseLocalAgentLeaseByAccountId(localAgentLeaseAccountId, {
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

export function startIpcWorker(enabledAccountIds: string[]): void {
  if (ipcWorkerRunning) {
    logger.debug('IPC 工作线程已在运行，跳过重复启动');
    return;
  }

  ipcWorkerRunning = true;
  logger.info(
    { accounts: enabledAccountIds.length },
    'Redis IPC 工作线程已启动',
  );

  for (const accountId of enabledAccountIds) {
    desiredAccountListeners.add(accountId);
    startAccountListenerSupervisor(accountId);
  }
}

export function addAccountListener(accountId: string): void {
  desiredAccountListeners.add(accountId);
  startAccountListenerSupervisor(accountId);
}

export function removeAccountListener(accountId: string): void {
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

export function _resetIpcWorkerForTests(): void {
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
  }
  accountListeners.clear();
  desiredAccountListeners.clear();
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
export function __getPendingAiChatRequestsForTests(): Map<
  string,
  PendingInboxRequest
> {
  return pendingAiChatRequests;
}

export function __getGlobalAgentConcurrencyStateForTests(): {
  activeKey: string;
  memberQueue: string;
  normalQueue: string;
  limit: number;
} {
  return {
    activeKey: GLOBAL_AGENT_CONCURRENCY_KEY,
    memberQueue: GLOBAL_AGENT_MEMBER_WAIT_QUEUE,
    normalQueue: GLOBAL_AGENT_NORMAL_WAIT_QUEUE,
    limit: DEFAULT_GLOBAL_AGENT_CONCURRENCY_LIMIT,
  };
}

export async function __peekNextGlobalAgentWaiterForTests(): Promise<
  string | null
> {
  return dequeueGlobalAgentWaiter();
}

/** AI Chat 请求超时时间（默认 30 分钟） */
const AI_CHAT_REQUEST_TIMEOUT = parseInt(
  process.env.AI_CHAT_REQUEST_TIMEOUT || '1800000',
  10,
);

/**
 * AI Chat 专属的入队函数。
 * 响应写入 `ipc:{accountId}:ai-chat:outbox`，永远不发微信。
 */
export function submitAiChatInboxRequest(input: {
  accountId: string;
  userMessage: string;
  inputKind?: ChatInputKind;
  pastedBoard?: UserPastedBoardInput;
  history: HistoryMessage[];
  sessionBoardContexts?: SessionBoardContext[];
  sessionId: string;
  userMessageId?: string;
  requestId?: string;
  userName?: string;
  assistantName?: string;
  personaPrompt?: string;
  guashiScriptTemplate?: string;
  authorizedSkillBundleIds?: string[];
  authorizedWorkflowSkillIds?: string[];
  llmRuntime?: EffectiveLlmRuntimeConfig;
  entitlementSnapshot?: RuntimeEntitlementSnapshot;
  waitForResponse?: boolean;
}): Promise<InboxRequestResult> {
  const requestId =
    input.requestId ??
    `aichat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAtMs = Date.now();
  const aiChatOutboxQueue = `ipc:${input.accountId}:ai-chat:outbox`;
  let acceptedEarly = false;
  let payloadQueued = false;

  return new Promise<InboxRequestResult>((resolve, reject) => {
    void (async () => {
      let timeout: NodeJS.Timeout | null = null;
      let billingReservation: BillingReservation | null = null;
      let concurrencySlotId: string | undefined;
      let localAgentLeaseAccountId: string | undefined;
      let runtimeReadyPromise: Promise<void> | undefined;

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
        const llmRuntime = input.llmRuntime
          ? llmRuntimeToSnapshot(input.llmRuntime)
          : await resolveLlmRuntimeSnapshot(ownerUserId);
        const entitlement =
          input.entitlementSnapshot ??
          (await getRuntimeEntitlementSnapshot(ownerUserId));

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

        timeout = setTimeout(async () => {
          const pending = pendingAiChatRequests.get(requestId);
          pendingAiChatRequests.delete(requestId);
          // 清除当前请求持有的会话忙碌标记，避免误删后续请求的锁。
          void releaseSessionProcessingLock(input.sessionId, requestId).catch(
            () => {},
          );
          void releaseGlobalAgentSlot(
            pending?.concurrencySlotId ?? concurrencySlotId,
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
        }, AI_CHAT_REQUEST_TIMEOUT);

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
          priority,
          concurrencySlotId,
          resolve,
          reject,
          timeout,
        });
        runtimeReadyPromise = (async () => {
          await ensureLocalAgentRunning(input.accountId);
          addAccountListener(input.accountId);
          localAgentLeaseAccountId = retainLocalAgent(input.accountId);
          if (!localAgentLeaseAccountId) {
            throw new Error('本地 agent-runtime 未启动或已退出，请稍后重试');
          }
          const leasedPending = pendingAiChatRequests.get(requestId);
          if (!leasedPending) {
            await releaseLocalAgentLeaseByAccountId(localAgentLeaseAccountId, {
              accountId: input.accountId,
              requestId,
              reason: 'request_cancelled_after_runtime_start',
            });
            throw new Error('请求已取消或超时');
          }
          leasedPending.localAgentLeaseAccountId = localAgentLeaseAccountId;
        })();
        void runtimeReadyPromise.catch(() => {});

        concurrencySlotId = await acquireGlobalAgentSlot({
          requestId,
          priority,
          shouldContinue: () => pendingAiChatRequests.has(requestId),
          onQueued: () => {
            if (input.waitForResponse !== false || acceptedEarly) return;
            acceptedEarly = true;
            resolve({
              requestId,
              status: 'success',
              text: '',
            });
          },
          onAcquired: (slotId) => {
            concurrencySlotId = slotId;
            const pending = pendingAiChatRequests.get(requestId);
            if (pending) {
              pending.concurrencySlotId = slotId;
            }
          },
        });
        if (!pendingAiChatRequests.has(requestId)) {
          throw new Error('请求已取消或超时');
        }

        await runtimeReadyPromise;

        const payload = JSON.stringify({
          type: 'chat',
          requestId,
          accountId: input.accountId,
          userMessage: input.userMessage,
          inputKind: input.inputKind,
          pastedBoard: input.pastedBoard,
          history: input.history,
          sessionBoardContexts: input.sessionBoardContexts,
          sessionId: input.sessionId,
          userMessageId: input.userMessageId,
          ownerUserId,
          userName: input.userName,
          assistantName: input.assistantName,
          personaPrompt: input.personaPrompt,
          guashiScriptTemplate: input.guashiScriptTemplate,
          authorizedSkillBundleIds: input.authorizedSkillBundleIds,
          authorizedWorkflowSkillIds: input.authorizedWorkflowSkillIds,
          llmRuntime,
          timestamp: new Date().toISOString(),
          outboxQueue: aiChatOutboxQueue, // 指定响应队列
        });

        // chat-session-service 已用同一个 requestId 预抢占锁；这里仅续期自有锁，避免旧请求覆盖新 owner。
        const processingClaimed = await claimOrRefreshSessionProcessingLock(
          input.sessionId,
          requestId,
          2100, // 35 分钟 TTL
        );
        if (!processingClaimed) {
          throw new Error('会话正在处理其他请求');
        }

        const pending = pendingAiChatRequests.get(requestId);
        if (!pending) {
          throw new Error('请求已取消或超时');
        }
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
        // 占用的 per-user metered 名额在任何失败分支都要释放,否则低余额用户会被永久卡住。
        await releasePerUserMeteredSlotByRequestId(requestId).catch(() => {});
        if (acceptedEarly && !payloadQueued) {
          await releaseGlobalAgentSlot(concurrencySlotId);
          const pending = pendingAiChatRequests.get(requestId);
          if (pending) {
            await processAiChatOutboxPayload(
              {
                type: 'response',
                accountId: input.accountId,
                requestId,
                sessionId: input.sessionId,
                userMessageId: input.userMessageId,
                ownerUserId: pending.ownerUserId,
                status: 'error',
                publicErrorText: '抱歉，AI 服务暂时不可用',
                publicReasonCode: 'submit_error',
                error: err instanceof Error ? err.message : String(err),
                timestamp: new Date().toISOString(),
                usage: {
                  promptTokens: 0,
                  completionTokens: 0,
                  totalTokens: 0,
                },
              },
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
        void releaseGlobalAgentSlot(concurrencySlotId);
        if (pending) {
          void releaseLocalAgentLeaseForPending(pending, {
            accountId: input.accountId,
            requestId,
            reason: 'submit_error',
          });
        } else {
          void releaseLocalAgentLeaseByAccountId(localAgentLeaseAccountId, {
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
