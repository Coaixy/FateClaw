import { randomUUID } from 'node:crypto';
import { getRedis } from '#infrastructure/redis';

import { getAgentConcurrencyLimit } from '#modules/system/system-config';
import { MAX_REQUEST_TIMEOUT_MS } from '#shared/timeout-chain';
import {
  ensureLocalAgentRunning,
  retainLocalAgent,
  releaseLocalAgent,
} from './local-runner.js';
import { capacityChanged, CAPACITY_CHANNEL } from './capacity-signal.js';

const GLOBAL_AGENT_CONCURRENCY_KEY = 'agent:concurrency:active';
const GLOBAL_AGENT_MEMBER_WAIT_QUEUE = 'agent:concurrency:waitq:member';
const GLOBAL_AGENT_NORMAL_WAIT_QUEUE = 'agent:concurrency:waitq:normal';
const GLOBAL_AGENT_WAIT_HEARTBEAT_KEY = 'agent:concurrency:wait:heartbeat';
const CAPACITY_RECONCILE_MS = 5_000;
const GLOBAL_AGENT_WAITER_HEARTBEAT_STALE_MS = 15_000;
const GLOBAL_AGENT_LIMIT_CACHE_MS = 2_000;
let cachedGlobalAgentConcurrencyLimit: {
  value: number;
  expiresAtMs: number;
} | null = null;
async function resolveGlobalAgentConcurrencyLimit(): Promise<number> {
  if (
    cachedGlobalAgentConcurrencyLimit &&
    cachedGlobalAgentConcurrencyLimit.expiresAtMs > Date.now()
  ) {
    return cachedGlobalAgentConcurrencyLimit.value;
  }
  const value = await getAgentConcurrencyLimit();
  cachedGlobalAgentConcurrencyLimit = {
    value,
    expiresAtMs: Date.now() + GLOBAL_AGENT_LIMIT_CACHE_MS,
  };
  return value;
}

async function enqueueGlobalAgentWaiter(
  queueKey: string,
  requestId: string,
): Promise<void> {
  const now = Date.now();
  await getRedis().eval(
    `
    redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
    redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
    return redis.call('PEXPIRE', KEYS[2], ARGV[3])`,
    2,
    queueKey,
    GLOBAL_AGENT_WAIT_HEARTBEAT_KEY,
    requestId,
    now,
    MAX_REQUEST_TIMEOUT_MS,
  );
}

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

export async function dequeueGlobalAgentWaiter(): Promise<string | null> {
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

async function acquireGlobalAgentSlot(input: {
  requestId: string;
  priority: 'member' | 'normal';
  shouldContinue?: () => boolean;
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
  try {
    while (true) {
      const revision = capacityChanged.revision;
      assertActive();
      const acquired = await tryAcquireQueuedGlobalAgentSlot({
        requestId: input.requestId,
        limit: await resolveGlobalAgentConcurrencyLimit(),
      });
      if (acquired.acquired) {
        input.onAcquired?.(input.requestId);
        assertActive();
        return input.requestId;
      }
      if (acquired.reason === 'missing') {
        await enqueueGlobalAgentWaiter(queue, input.requestId);
      }
      await capacityChanged.wait(CAPACITY_RECONCILE_MS, revision);
    }
  } catch (err) {
    await removeGlobalAgentWaiter(queue, input.requestId).catch(() => {});
    throw err;
  }
}

export async function releaseGlobalAgentSlot(
  slotId?: string,
  capacityToken?: string,
): Promise<void> {
  if (!slotId) return;
  try {
    await getRedis().eval(
      `
      if ARGV[3] ~= '' and redis.call('HGET', KEYS[2], 'token') ~= ARGV[3] then return 0 end
      redis.call('ZREM', KEYS[1], ARGV[1])
      local accountKey = redis.call('HGET', KEYS[2], 'accountKey')
      local activeValue = redis.call('HGET', KEYS[2], 'activeValue')
      if accountKey and redis.call('GET', accountKey) == activeValue then redis.call('DEL', accountKey) end
      redis.call('DEL', KEYS[2])
      return redis.call('PUBLISH', ARGV[2], 'available')`,
      2,
      GLOBAL_AGENT_CONCURRENCY_KEY,
      `agent:runtime:owner:${slotId}`,
      slotId,
      CAPACITY_CHANNEL,
      capacityToken ?? '',
    );
  } finally {
    capacityChanged.notify();
  }
}

export async function acquireAgentExecution(input: {
  requestId: string;
  accountId: string;
  priority: 'member' | 'normal';
  deadlineAtMs: number;
  shouldContinue: () => boolean;
  onRuntimeReady: (leaseId: string, capacityToken: string) => boolean;
  beforeGlobal?: () => Promise<void>;
  onAcquired?: (slotId: string) => void;
  onTiming?: (
    stage: 'account_wait' | 'runtime_ready' | 'queue',
    durationMs: number,
  ) => void;
}): Promise<string> {
  const activeKey = `agent:runtime:active:${input.accountId}`;
  const waitKey = `agent:runtime:wait:${input.accountId}`;
  const ownerKey = `agent:runtime:owner:${input.requestId}`;
  const heartbeatKey = `${waitKey}:heartbeat`;
  const capacityToken = randomUUID();
  let stageStartedAt = Date.now();
  const assertActive = () => {
    if (!input.shouldContinue() || Date.now() >= input.deadlineAtMs)
      throw new Error('请求已取消或超时');
  };
  try {
    assertActive();
    while (true) {
      const revision = capacityChanged.revision;
      assertActive();
      const acquired = await getRedis().eval(
        `
        redis.call('HSET', KEYS[4], ARGV[1], ARGV[2])
        redis.call('PEXPIRE', KEYS[4], ARGV[5])
        redis.call('ZADD', KEYS[1], 'NX', ARGV[2], ARGV[1])
        redis.call('PEXPIRE', KEYS[1], ARGV[5])
        for i=1,10 do
          local head = redis.call('ZRANGE', KEYS[1], 0, 0)[1]
          if not head then return 0 end
          if tonumber(ARGV[2])-tonumber(redis.call('HGET', KEYS[4], head) or '0') > tonumber(ARGV[4]) then
            redis.call('ZREM', KEYS[1], head)
            redis.call('HDEL', KEYS[4], head)
          else
            if head ~= ARGV[1] or redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
            redis.call('SET', KEYS[2], ARGV[1] .. ':' .. ARGV[6], 'PX', ARGV[3])
            redis.call('HSET', KEYS[3], 'accountKey', KEYS[2], 'activeValue', ARGV[1] .. ':' .. ARGV[6], 'token', ARGV[6])
            redis.call('PEXPIRE', KEYS[3], ARGV[3])
            redis.call('ZREM', KEYS[1], ARGV[1])
            redis.call('HDEL', KEYS[4], ARGV[1])
            return 1
          end
        end
        return 0`,
        4,
        waitKey,
        activeKey,
        ownerKey,
        heartbeatKey,
        input.requestId,
        Date.now(),
        Math.max(1, input.deadlineAtMs - Date.now()),
        GLOBAL_AGENT_WAITER_HEARTBEAT_STALE_MS,
        MAX_REQUEST_TIMEOUT_MS,
        capacityToken,
      );
      if (acquired === 1) break;
      await capacityChanged.wait(
        Math.min(
          CAPACITY_RECONCILE_MS,
          Math.max(1, input.deadlineAtMs - Date.now()),
        ),
        revision,
      );
    }
    assertActive();
    input.onTiming?.('account_wait', Date.now() - stageStartedAt);
    stageStartedAt = Date.now();
    await ensureLocalAgentRunning(input.accountId, {
      deadlineAtMs: input.deadlineAtMs,
      isCancelled: () => !input.shouldContinue(),
    });
    assertActive();
    const leaseId = retainLocalAgent(input.accountId);
    if (!leaseId)
      throw new Error('本地 agent-runtime 未启动或已退出，请稍后重试');
    // An accepted lease is released by the pending request's lifecycle owner.
    if (!input.onRuntimeReady(leaseId, capacityToken)) {
      await releaseLocalAgent(leaseId);
      throw new Error('请求已取消或超时');
    }
    input.onTiming?.('runtime_ready', Date.now() - stageStartedAt);
    stageStartedAt = Date.now();
    await input.beforeGlobal?.();
    assertActive();
    const slot = await acquireGlobalAgentSlot(input);
    input.onTiming?.('queue', Date.now() - stageStartedAt);
    return slot;
  } catch (error) {
    await releaseGlobalAgentSlot(input.requestId, capacityToken).catch(
      () => {},
    );
    throw error;
  } finally {
    await getRedis()
      .zrem(waitKey, input.requestId)
      .catch(() => {});
    await getRedis()
      .hdel(heartbeatKey, input.requestId)
      .catch(() => {});
  }
}

export function resetAgentScheduler(): void {
  cachedGlobalAgentConcurrencyLimit = null;
  capacityChanged.reset();
}

export const stopAgentScheduler = () => capacityChanged.reset();

export async function getAgentConcurrencyKeys() {
  return {
    activeKey: GLOBAL_AGENT_CONCURRENCY_KEY,
    memberQueue: GLOBAL_AGENT_MEMBER_WAIT_QUEUE,
    normalQueue: GLOBAL_AGENT_NORMAL_WAIT_QUEUE,
    limit: await resolveGlobalAgentConcurrencyLimit(),
  };
}
