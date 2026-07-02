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

import { acquireRedisWorkerLock, getRedis } from '../infrastructure/redis.js';
import { logger } from '../infrastructure/logger.js';
import { processAiChatOutboxPayload } from './ipc-ai-chat-outbox-handler.js';
import {
  buildAiChatErrorResponsePayload,
  type PendingInboxRequest,
} from './ipc-payloads.js';

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
/**
 * 单个队列单轮最多清理的消息数：正常堆积（实测几十条）一轮即可清空；上限用于
 * 防止极端堆积时单队列清理耗时超过锁 TTL（`SWEEP_LOCK_TTL_MS`）导致锁在处理
 * 途中过期，剩余的留到下一轮继续。
 */
const MAX_CLEANUP_PER_QUEUE_PER_SWEEP = 200;

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

/** 扫描所有 inbox 队列 key（`ipc:*:inbox*`），游标分批直到遍历完 keyspace。 */
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
  // 连续清理队尾（RPOP 端 = 最久未消费）所有已超清理阈值的消息：消费者掉线时
  // 单个队列可能堆积几十条，若每轮只处理一条，N 条要 N 个巡检周期（分钟级）才清完，
  // 恢复太慢。因此这里对同一队列连续处理，直到遇到不该动的消息（未超阈值/脏数据/
  // 非站内 AI Chat 形状/队尾被消费者取走）就停下。每次只从队尾读一条，并用
  // popIfStillTail 原子确认后再弹出，绝不盲目 RPOP，避免和恰好复活的消费者踩踏。
  let cleaned = 0;
  while (cleaned < MAX_CLEANUP_PER_QUEUE_PER_SWEEP) {
    const tail = await getRedis().lrange(queueKey, -1, -1);
    if (tail.length === 0) return;
    const raw = tail[0];

    let payload: StaleInboxPayload;
    try {
      payload = JSON.parse(raw) as StaleInboxPayload;
    } catch {
      return; // 解析不了的脏数据挡在队尾，不是本任务职责，本队列到此为止
    }

    const timestampMs =
      typeof payload.timestamp === 'string'
        ? Date.parse(payload.timestamp)
        : NaN;
    if (!Number.isFinite(timestampMs)) return;
    const ageMs = Date.now() - timestampMs;
    // 队尾是最久的一条；它都没到告警阈值，前面（更新的）更不可能到，结束本队列。
    if (ageMs < WARN_THRESHOLD_MS) return;

    if (ageMs < FAIL_THRESHOLD_MS) {
      logger.warn(
        { queueKey, requestId: payload.requestId, ageMs },
        'AI Chat: inbox 队列消息堆积超过告警阈值，尚未到自动清理阈值',
      );
      return; // 最久的一条尚未到清理阈值，本队列本轮无可清理
    }

    if (!isRecoverableAiChatInboxPayload(payload)) {
      logger.warn(
        { queueKey, requestId: payload.requestId, ageMs, type: payload.type },
        'AI Chat: inbox 队列消息堆积超过清理阈值，但不是可识别的站内 AI Chat 消息，跳过自动清理',
      );
      return; // 不能安全清理的消息挡在队尾，不能越过它去动后面的，本队列到此为止
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
      typeof payload.userMessageId === 'string'
        ? payload.userMessageId
        : undefined;
    const ownerUserId =
      typeof payload.ownerUserId === 'string' ? payload.ownerUserId : undefined;
    const text = '这条消息处理超时（后台长时间未响应），请重新发送试试。';

    await processAiChatOutboxPayload(
      buildAiChatErrorResponsePayload({
        accountId,
        requestId,
        sessionId,
        userMessageId,
        ownerUserId,
        publicErrorText: text,
        error: `inbox 消息堆积超过 ${Math.round(FAIL_THRESHOLD_MS / 60_000)} 分钟未被消费，判定为处理超时`,
        reasonCode: 'inbox_stall_timeout',
      }),
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
    cleaned += 1;
  }

  // 达到单轮上限仍未清空：剩余留待下一轮，避免单队列清理耗时超过锁 TTL。
  logger.warn(
    { queueKey, cleaned },
    'AI Chat: inbox 单队列单轮清理达到上限，剩余留待下一轮继续',
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
    const lock = await acquireRedisWorkerLock(SWEEP_LOCK_KEY, SWEEP_LOCK_TTL_MS);
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
