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

import { getUserByAccountId, getUserById } from '../infrastructure/db.js';
import { LOW_BALANCE_CONCURRENCY_THRESHOLD_COINS } from '../infrastructure/config.js';
import { processOutboxPayload } from './ipc-outbox-handler.js';
import { processAiChatOutboxPayload } from './ipc-ai-chat-outbox-handler.js';
import {
  getRuntimeEntitlementSnapshot,
  type RuntimeEntitlementSnapshot,
} from '../modules/billing/entitlements.js';

import {
  AGENT_REQUEST_TIMEOUT_MS as AGENT_REQUEST_TIMEOUT,
  AI_CHAT_REQUEST_TIMEOUT_MS as AI_CHAT_REQUEST_TIMEOUT,
  MAX_REQUEST_TIMEOUT_MS,
  SESSION_PROCESSING_LOCK_TTL_SECONDS,
} from '../shared/timeout-chain.js';

const DEFAULT_GLOBAL_AGENT_CONCURRENCY_LIMIT = Math.max(
  1,
  parseInt(process.env.AGENT_CONCURRENCY_LIMIT || '10', 10) || 10,
);
const GLOBAL_AGENT_CONCURRENCY_KEY = 'agent:concurrency:active';
// 等待队列：ZSET（score=入队毫秒时间戳，天然按入队先后排序）。
// 曾用 LIST 实现（agent:concurrency:wait:member/normal）：把 requestId 移出队列的唯一
// 路径是等待者自己 catch 里的 LREM——API 进程在排队期间崩溃/重启时，孤儿 requestId
// 永卡队尾，同优先级所有后继请求永远轮不到（活性死锁），只能人工清 Redis。
// 改为 ZSET + 心跳哈希：等待者每次轮询报活，任何存活等待者的 Lua 调用都会原子驱逐
// 心跳超时的死亡队头，毒化窗口从「无限」缩到心跳超时（秒级）。
const GLOBAL_AGENT_MEMBER_WAIT_QUEUE = 'agent:concurrency:waitq:member';
const GLOBAL_AGENT_NORMAL_WAIT_QUEUE = 'agent:concurrency:waitq:normal';
/** 等待者心跳哈希：field=requestId，value=最近一次轮询的毫秒时间戳。 */
const GLOBAL_AGENT_WAIT_HEARTBEAT_KEY = 'agent:concurrency:wait:heartbeat';
/** 旧版 LIST 等待队列 key，仅用于启动时一次性清理残留（见 startIpcWorker）。 */
const LEGACY_GLOBAL_AGENT_WAIT_LIST_KEYS = [
  'agent:concurrency:wait:member',
  'agent:concurrency:wait:normal',
];
const GLOBAL_AGENT_GATE_POLL_MS = 500;
/**
 * 等待者心跳过期阈值：超过此时长没报活视为进程已死，可被其他等待者驱逐。
 * 取轮询间隔（500ms）的 30 倍，对 GC 停顿/事件循环卡顿留足余量。
 */
const GLOBAL_AGENT_WAITER_HEARTBEAT_STALE_MS = 15_000;
const GLOBAL_AGENT_LIMIT_CACHE_MS = 2_000;
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
import { logger } from '../infrastructure/logger.js';
import type { BillingReservation } from '../modules/billing/plans.js';
import {
  applyNonMemberPricingMarkup,
  reserveBillingForRequest,
  settleBillingReservationDetailed,
} from '../modules/billing/plans.js';
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
  onLocalAgentProcessExit,
  type LocalAgentProcessExitInfo,
} from './local-runner.js';
import { FREE_WECHAT_UNSUPPORTED_MESSAGE } from '../modules/account/account-service.js';
import { getUserIdFromWebChatRuntimeId } from '../modules/chat/web-chat-runtime.js';
import type { User, NewMessage } from '../shared/types.js';
import {
  admitAgentRequest,
  markAgentRequestDispatched,
  requestAgentCancellation,
  persistAgentFailure,
} from '../infrastructure/repositories/agent-requests-repository.js';
import {
  tryAcquireBenefitExecutionSlot,
  ModelSelectionError,
} from '../infrastructure/repositories/benefit-repository.js';
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
const accountListeners = new Map<string, { running: boolean; redis: Redis }>();
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

/**
 * 把 requestId 登记进全局并发等待队列（ZSET）并写入初始心跳。
 *
 * @param queueKey 目标等待队列（会员或普通）。
 * @param requestId 等待者请求 ID。
 * @remarks 心跳哈希带滚动 PEXPIRE 兜底：即使所有清理路径都失效，
 *          哈希本身也会在最大请求超时后整体过期，不会永久泄漏。
 */
async function enqueueGlobalAgentWaiter(
  queueKey: string,
  requestId: string,
): Promise<void> {
  const now = Date.now();
  const redis = getRedis();
  await redis.zadd(queueKey, now, requestId);
  await redis.hset(GLOBAL_AGENT_WAIT_HEARTBEAT_KEY, requestId, now);
  await redis.pexpire(GLOBAL_AGENT_WAIT_HEARTBEAT_KEY, MAX_REQUEST_TIMEOUT_MS);
}

/**
 * 把 requestId 从全局并发等待队列移除（取消/超时/异常时的自清理路径）。
 *
 * @param queueKey 等待队列 key。
 * @param requestId 等待者请求 ID。
 */
async function removeGlobalAgentWaiter(
  queueKey: string,
  requestId: string,
): Promise<void> {
  const redis = getRedis();
  await redis.zrem(queueKey, requestId);
  await redis.hdel(GLOBAL_AGENT_WAIT_HEARTBEAT_KEY, requestId);
}

async function tryAcquireQueuedGlobalAgentSlot(input: {
  requestId: string;
  limit: number;
}): Promise<{ acquired: boolean; reason: string }> {
  // Lua 原子逻辑：
  // 1. 先为自己报活（HSET 心跳），保证只要还在轮询就不会被别人驱逐；
  // 2. 惰性清理 active ZSET 中的陈旧槽位（持有超过最大请求超时=已死）；
  // 3. liveHead：取等待队列队头时，跳过并驱逐心跳超时的死亡等待者
  //    （单次最多驱逐 10 个，防单次调用过长；漏网的下一次轮询继续清）；
  // 4. 会员队列优先；只有队头是自己才允许占槽（保序）。
  // 返回 {acquired, reason}；reason='missing' 表示自己已不在任何队列
  // （被误判驱逐或从未入队），调用方需重新入队。
  const result = await getRedis().eval(
    `
    redis.call('HSET', KEYS[4], ARGV[4], ARGV[2])
    redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[3])
    local now = tonumber(ARGV[2])
    local hbStale = tonumber(ARGV[5])
    local function liveHead(zkey)
      for i = 1, 10 do
        local head = redis.call('ZRANGE', zkey, 0, 0)[1]
        if not head then return nil end
        local hb = tonumber(redis.call('HGET', KEYS[4], head) or '0')
        if now - hb <= hbStale then return head end
        redis.call('ZREM', zkey, head)
        redis.call('HDEL', KEYS[4], head)
      end
      return redis.call('ZRANGE', zkey, 0, 0)[1]
    end
    if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then
      return {0, 'busy'}
    end
    local memberHead = liveHead(KEYS[2])
    if memberHead then
      if memberHead ~= ARGV[4] then
        return {0, 'not_turn'}
      end
      redis.call('ZREM', KEYS[2], ARGV[4])
      redis.call('HDEL', KEYS[4], ARGV[4])
      redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
      return {1, 'member'}
    end
    local normalHead = liveHead(KEYS[3])
    if normalHead then
      if normalHead ~= ARGV[4] then
        return {0, 'not_turn'}
      end
      redis.call('ZREM', KEYS[3], ARGV[4])
      redis.call('HDEL', KEYS[4], ARGV[4])
      redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
      return {1, 'normal'}
    end
    return {0, 'missing'}
    `,
    4,
    GLOBAL_AGENT_CONCURRENCY_KEY,
    GLOBAL_AGENT_MEMBER_WAIT_QUEUE,
    GLOBAL_AGENT_NORMAL_WAIT_QUEUE,
    GLOBAL_AGENT_WAIT_HEARTBEAT_KEY,
    input.limit,
    Date.now(),
    Date.now() - MAX_REQUEST_TIMEOUT_MS,
    input.requestId,
    GLOBAL_AGENT_WAITER_HEARTBEAT_STALE_MS,
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
  // ZSET 队头（score 最小 = 最早入队）即下一个候选；会员队列优先。
  const memberHead = await getRedis().zrange(
    GLOBAL_AGENT_MEMBER_WAIT_QUEUE,
    0,
    0,
  );
  if (memberHead[0]) return memberHead[0];
  const normalHead = await getRedis().zrange(
    GLOBAL_AGENT_NORMAL_WAIT_QUEUE,
    0,
    0,
  );
  return normalHead[0] ?? null;
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
  await enqueueGlobalAgentWaiter(queue, input.requestId);
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
      if (acquired.reason === 'missing') {
        // 自己已不在任何等待队列：极端情况下（心跳误判、Redis 被清）会被驱逐，
        // 重新入队继续等（排到队尾，公平性可接受——被误逐说明心跳已断很久）。
        await enqueueGlobalAgentWaiter(queue, input.requestId);
      }
      await delay(GLOBAL_AGENT_GATE_POLL_MS);
    }
  } catch (err) {
    await removeGlobalAgentWaiter(queue, input.requestId).catch(() => {
      // 等待队列清理失败不应覆盖原始入队/抢占错误；残留项会被心跳驱逐兜底。
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
  const redis = getRedis().duplicate();
  const listener = { running: true, redis };
  accountListeners.set(accountId, listener);
  let lastActivityAtMs = Date.now();

  logger.info({ accountId }, '启动 Redis IPC 监听');

  try {
    while (listener.running) {
      const aiQueue = `ipc:${accountId}:ai-chat:outbox`;
      const aiRaw = await claimAiChatResult(aiQueue);
      const result =
        aiRaw !== null
          ? [aiQueue, aiRaw]
          : await redis.brpop(`ipc:${accountId}:outbox`, 1);

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
        const payload = JSON.parse(raw) as unknown;
        try {
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
        } finally {
          await releaseGlobalAgentSlotForPayload(queue, payload).catch(
            (err) => {
              logger.warn({ accountId, queue, err }, '释放 agent 并发槽位失败');
            },
          );
        }
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

        localAgentLeaseId = retainLocalAgent(input.accountId);
        if (!localAgentLeaseId) {
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
          localAgentLeaseId,
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
        void releaseGlobalAgentSlot(concurrencySlotId);
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
    ([, pending]) => pending.accountId === accountId,
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
    .del(...LEGACY_GLOBAL_AGENT_WAIT_LIST_KEYS)
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
  authorizedSkillIds?: string[];
  llmRuntime?: EffectiveLlmRuntimeConfig;
  entitlementSnapshot?: RuntimeEntitlementSnapshot;
  waitForResponse?: boolean;
  messageToPersist?: NewMessage;
  recoveryExecutionId?: string;
  recoveryDeadlineAt?: string;
}): Promise<InboxRequestResult> {
  const requestId =
    input.requestId ??
    `aichat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAtMs = Date.now();
  const aiChatOutboxQueue = `ipc:${input.accountId}:ai-chat:outbox`;
  let acceptedEarly = false;
  let payloadQueued = false;
  let executionId = input.recoveryExecutionId;
  let admissionRuntime: LlmRuntimeSnapshot | undefined;
  const benefitPolicy =
    input.llmRuntime?.poolKey === 'benefit'
      ? input.llmRuntime.benefitPolicy
      : undefined;
  const queueDeadlineAtMs =
    benefitPolicy && input.recoveryDeadlineAt
      ? Date.parse(input.recoveryDeadlineAt) -
        benefitPolicy.execution_timeout_seconds * 1000
      : startedAtMs + (benefitPolicy?.queue_timeout_seconds ?? 1800) * 1000;
  const deadlineAtMs = input.recoveryDeadlineAt
    ? Date.parse(input.recoveryDeadlineAt)
    : startedAtMs +
      (benefitPolicy
        ? (benefitPolicy.execution_timeout_seconds +
            benefitPolicy.queue_timeout_seconds) *
          1000
        : AI_CHAT_REQUEST_TIMEOUT);

  return new Promise<InboxRequestResult>((resolve, reject) => {
    void (async () => {
      let timeout: NodeJS.Timeout | null = null;
      let billingReservation: BillingReservation | null = null;
      let concurrencySlotId: string | undefined;
      let localAgentLeaseId: string | undefined;
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
          priority,
          concurrencySlotId,
          resolve,
          reject,
          timeout,
        });
        if (input.waitForResponse === false) {
          acceptedEarly = true;
          resolve({ requestId, status: 'success', text: '' });
        }
        runtimeReadyPromise = (async () => {
          await ensureLocalAgentRunning(input.accountId, {
            deadlineAtMs,
            isCancelled: () => !pendingAiChatRequests.has(requestId),
          });
          addAccountListener(input.accountId);
          localAgentLeaseId = retainLocalAgent(input.accountId);
          if (!localAgentLeaseId) {
            throw new Error('本地 agent-runtime 未启动或已退出，请稍后重试');
          }
          const leasedPending = pendingAiChatRequests.get(requestId);
          if (!leasedPending) {
            await releaseLocalAgentLeaseById(localAgentLeaseId, {
              accountId: input.accountId,
              requestId,
              reason: 'request_cancelled_after_runtime_start',
            });
            throw new Error('请求已取消或超时');
          }
          leasedPending.localAgentLeaseId = localAgentLeaseId;
        })();
        void runtimeReadyPromise.catch(() => {});

        if (llmRuntime.poolKey === 'benefit') {
          while (!(await tryAcquireBenefitExecutionSlot(requestId))) {
            if (
              !pendingAiChatRequests.has(requestId) ||
              Date.now() >= queueDeadlineAtMs
            )
              throw new Error('免费服务繁忙，请稍后重试。本次未扣免费次数。');
            await new Promise<void>((done) =>
              setTimeout(done, GLOBAL_AGENT_GATE_POLL_MS),
            );
          }
        }
        concurrencySlotId = await acquireGlobalAgentSlot({
          requestId,
          priority,
          shouldContinue: () =>
            pendingAiChatRequests.has(requestId) &&
            (!benefitPolicy || Date.now() < queueDeadlineAtMs),
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
          executionId,
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
          if (!submissionFailure) return;
          await releaseGlobalAgentSlot(concurrencySlotId);
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
        void releaseGlobalAgentSlot(concurrencySlotId);
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

export type AiChatSubmission = Parameters<typeof submitAiChatInboxRequest>[0];

export const __getPendingAiChatRequestsForTests = getPendingAiChatRequests;
