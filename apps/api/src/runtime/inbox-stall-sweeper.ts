/**
 * AI Chat inbox 堆积巡检 + 自愈任务（inbox stall sweeper）。
 *
 * 背景：账号级本地 agent-runtime 子进程一旦停止消费 Redis inbox 队列
 * （`ipc:{accountId}:inbox` / `ipc:{accountId}:inbox:member`），消息会永远堆在
 * 队列里没人处理——这是唯一完全没有自动过期机制的一环：`session:processing:*`
 * 锁有 35 分钟 TTL、`agent:concurrency:active` 槽位在下次有新请求申请时会被惰性
 * 清理（30 分钟阈值），都已经"自愈"，只是慢、且没有任何告警；inbox 队列本身
 * （Redis List）没有 TTL，只能靠消费者 RPOP，一旦消费者掉线就会无限堆积
 * （实测过一次堆积近 8 小时才被用户投诉发现）。
 *
 * 本任务定期巡检这些队列：堆积超过告警阈值先记日志，超过更长的清理阈值则判定
 * 为处理超时，主动把消息标记为失败——复用 `processAiChatOutboxPayload` 走和
 * 正常错误响应完全一致的落库/推流/释放锁流程，用户不用再干等到顶层粗粒度超时。
 */

import crypto from 'node:crypto';

import { getRedis } from '../infrastructure/redis.js';
import { logger } from '../infrastructure/logger.js';
import { processAiChatOutboxPayload } from './ipc-ai-chat-outbox-handler.js';
import type { PendingInboxRequest } from './ipc-payloads.js';

/** 巡检运行间隔：每 1 分钟一次。 */
const SWEEP_INTERVAL_MS = 60 * 1000;
/** 告警阈值：堆积超过此时长只记日志，不动数据。 */
const WARN_THRESHOLD_MS = 5 * 60 * 1000;
/**
 * 自动清理阈值：比 agent-runtime 单请求硬超时（`AGENT_RUNTIME_REQUEST_TIMEOUT_MS`，
 * 默认 8 分钟）更长，避免误杀"排在一条慢请求后面、暂时还没轮到"的正常消息。
 */
const FAIL_THRESHOLD_MS = 10 * 60 * 1000;
const SWEEP_LOCK_KEY = 'inbox-stall-sweep:worker-lock';
/** 多实例分布式锁 TTL，略小于运行间隔，避免锁在下一轮开始前还没释放。 */
const SWEEP_LOCK_TTL_MS = 55 * 1000;
const INBOX_SCAN_MATCH = 'ipc:*:inbox*';
const INBOX_SCAN_COUNT = 200;

let timer: NodeJS.Timeout | null = null;
let running = false;

interface StaleInboxPayload {
  type?: unknown;
  requestId?: unknown;
  accountId?: unknown;
  sessionId?: unknown;
  userMessageId?: unknown;
  ownerUserId?: unknown;
  timestamp?: unknown;
}

/**
 * 判断堆积消息是否是可以安全按站内 AI Chat 逻辑清理的请求。
 *
 * inbox 队列同时被通用 resident agent 调度（微信等场景，`type` 也可能是
 * `'chat'`）复用，两者 payload 形状不同。这里用三重校验兜底：`requestId`
 * 前缀（站内 AI Chat 固定 `aichat-` 开头，见 `chat-session-service.ts` 的
 * `createAiChatRequestId`）+ `accountId` + 非空 `sessionId`（微信
 * autoDeliver=true 场景没有 sessionId）。三者都满足才认为形状匹配，
 * 否则只告警、不动数据，避免误处理非 AI Chat 消息。
 */
function isRecoverableAiChatInboxPayload(payload: StaleInboxPayload): boolean {
  return (
    payload.type === 'chat' &&
    typeof payload.requestId === 'string' &&
    payload.requestId.startsWith('aichat-') &&
    typeof payload.accountId === 'string' &&
    typeof payload.sessionId === 'string' &&
    payload.sessionId.trim().length > 0
  );
}

async function acquireWorkerLock(): Promise<{
  token: string;
  release: () => Promise<void>;
} | null> {
  const token = crypto.randomUUID();
  const acquired = await getRedis().set(
    SWEEP_LOCK_KEY,
    token,
    'PX',
    SWEEP_LOCK_TTL_MS,
    'NX',
  );
  if (acquired !== 'OK') {
    return null;
  }

  return {
    token,
    release: async () => {
      // 只释放自己持有的锁，避免锁过期后误删其他实例新拿到的锁。
      await getRedis().eval(
        `if redis.call("get", KEYS[1]) == ARGV[1] then
           return redis.call("del", KEYS[1])
         end
         return 0`,
        1,
        SWEEP_LOCK_KEY,
        token,
      );
    },
  };
}

async function scanInboxKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await getRedis().scan(
      cursor,
      'MATCH',
      INBOX_SCAN_MATCH,
      'COUNT',
      INBOX_SCAN_COUNT,
    );
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

/**
 * 原子弹出：只有队尾仍是给定的原始字符串时才 RPOP。
 * 避免"巡检读到陈旧消息"和"消费者恰好这时候复活开始消费"之间的竞态——
 * 弹出的必须确认还是同一条消息，不能盲目 RPOP 队尾。
 */
async function popIfStillTail(
  queueKey: string,
  expectedRaw: string,
): Promise<boolean> {
  const popped = await getRedis().eval(
    `if redis.call("lindex", KEYS[1], -1) == ARGV[1] then
       redis.call("rpop", KEYS[1])
       return 1
     end
     return 0`,
    1,
    queueKey,
    expectedRaw,
  );
  return popped === 1;
}

async function sweepQueue(queueKey: string): Promise<void> {
  // 只读队尾（最久未消费的一条），不影响正常消费者按 RPOP 顺序处理。
  const tail = await getRedis().lrange(queueKey, -1, -1);
  if (tail.length === 0) return;
  const raw = tail[0];

  let payload: StaleInboxPayload;
  try {
    payload = JSON.parse(raw) as StaleInboxPayload;
  } catch {
    return; // 解析不了的脏数据不是本任务职责，不动它
  }

  const timestampMs =
    typeof payload.timestamp === 'string' ? Date.parse(payload.timestamp) : NaN;
  if (!Number.isFinite(timestampMs)) return;
  const ageMs = Date.now() - timestampMs;
  if (ageMs < WARN_THRESHOLD_MS) return;

  if (ageMs < FAIL_THRESHOLD_MS) {
    logger.warn(
      { queueKey, requestId: payload.requestId, ageMs },
      'AI Chat: inbox 队列消息堆积超过告警阈值，尚未到自动清理阈值',
    );
    return;
  }

  if (!isRecoverableAiChatInboxPayload(payload)) {
    logger.warn(
      { queueKey, requestId: payload.requestId, ageMs, type: payload.type },
      'AI Chat: inbox 队列消息堆积超过清理阈值，但不是可识别的站内 AI Chat 消息，跳过自动清理',
    );
    return;
  }

  const popped = await popIfStillTail(queueKey, raw);
  if (!popped) {
    // 弹出时队尾已经变化（被真正复活的消费者取走，或有更新的消息顶上来），
    // 本轮不处理，避免和消费者踩踏。
    return;
  }

  const requestId = payload.requestId as string;
  const accountId = payload.accountId as string;
  const sessionId = payload.sessionId as string;
  const userMessageId =
    typeof payload.userMessageId === 'string' ? payload.userMessageId : undefined;
  const ownerUserId =
    typeof payload.ownerUserId === 'string' ? payload.ownerUserId : undefined;
  const text = '这条消息处理超时（后台长时间未响应），请重新发送试试。';

  await processAiChatOutboxPayload(
    {
      type: 'response',
      accountId,
      requestId,
      sessionId,
      userMessageId,
      ownerUserId,
      status: 'error',
      text,
      error: `inbox 消息堆积超过 ${Math.round(FAIL_THRESHOLD_MS / 60_000)} 分钟未被消费，判定为处理超时`,
      publicErrorText: text,
      publicReasonCode: 'inbox_stall_timeout',
      timestamp: new Date().toISOString(),
    },
    accountId,
    new Map<string, PendingInboxRequest>(),
  ).catch((err) => {
    logger.error(
      { queueKey, requestId, err },
      'AI Chat: inbox 堆积自动清理时标记失败响应也失败了',
    );
  });

  logger.error(
    { queueKey, requestId, sessionId, ageMs },
    'AI Chat: inbox 消息堆积超过清理阈值，已自动标记为超时失败并清理',
  );
}

/**
 * 跑一轮巡检。错误逐个队列吞掉，单个队列失败不影响其余队列继续巡检。
 */
export async function runInboxStallSweepOnce(): Promise<void> {
  if (running) {
    logger.debug('inbox 堆积巡检仍在运行，跳过本轮');
    return;
  }

  running = true;
  try {
    const lock = await acquireWorkerLock();
    if (!lock) {
      logger.debug('inbox 堆积巡检锁已被其他实例持有，跳过本轮');
      return;
    }

    try {
      const keys = await scanInboxKeys();
      for (const key of keys) {
        try {
          await sweepQueue(key);
        } catch (err) {
          logger.warn({ key, err }, 'inbox 堆积巡检：单个队列处理失败');
        }
      }
    } finally {
      await lock.release();
    }
  } catch (err) {
    logger.warn({ err }, 'inbox 堆积巡检出错');
  } finally {
    running = false;
  }
}

/** 启动 inbox 堆积巡检后台任务。 */
export function startInboxStallSweeper(): void {
  if (timer) {
    logger.warn('inbox 堆积巡检任务已在运行，跳过重复启动');
    return;
  }
  logger.info(
    {
      intervalMs: SWEEP_INTERVAL_MS,
      warnThresholdMs: WARN_THRESHOLD_MS,
      failThresholdMs: FAIL_THRESHOLD_MS,
    },
    '启动 inbox 堆积巡检后台任务',
  );
  runInboxStallSweepOnce().catch(() => {
    /* 错误已在 runInboxStallSweepOnce 内部 logger.warn */
  });
  timer = setInterval(() => {
    runInboxStallSweepOnce().catch(() => {
      /* 同上 */
    });
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}

/** 停止 inbox 堆积巡检任务，用于测试或优雅关闭。 */
export function stopInboxStallSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
