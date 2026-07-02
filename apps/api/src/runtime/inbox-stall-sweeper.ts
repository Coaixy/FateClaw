/**
 * AI Chat IPC 队列堆积巡检 + 自愈任务（inbox/outbox stall sweeper）。
 *
 * 巡检两个方向的队列：
 *
 * 1. inbox（`ipc:{accountId}:inbox` / `:inbox:member`）：账号级本地 agent-runtime
 *    子进程一旦停止消费，消息会永远堆在队列里没人处理——Redis List 没有 TTL，
 *    只能靠消费者 RPOP，消费者掉线就无限堆积（实测过一次堆积近 8 小时才被用户
 *    投诉发现）。堆积超过告警阈值先告警，超过清理阈值则判定处理超时、主动把
 *    消息标记为失败——复用 `processAiChatOutboxPayload` 走和正常错误响应完全
 *    一致的落库/推流/释放锁流程。
 *
 * 2. ai-chat outbox（`ipc:{accountId}:ai-chat:outbox`）：站内 AI Chat 的监听器是
 *    发消息时懒创建的、且随进程重启丢失——API 非优雅重启后，孤儿 agent 子进程
 *    仍可能把最终响应推进 outbox，但新进程没有该账号的监听器，响应会永久滞留，
 *    用户永远看不到已经生成好的回复。监听器空闲回收（见 ipc-worker.ts）后迟到的
 *    消息同理。outbox 消息在有监听器时毫秒级被消费，队尾消息超过无主阈值即断定
 *    没有消费者，由本任务代为消费：最终响应正常落库 + 推流（响应落库有
 *    payload.sessionId 兜底，不依赖本机 pending），计费由 billing-sweeper 按
 *    conversation_logs 补结算。微信 `ipc:*:outbox` 不代消费（有发微信副作用），
 *    只告警。
 *
 * 另有心跳升级：daemon 会周期性写 `agent:heartbeat:{accountId}`（见 daemon.ts）。
 * inbox 有堆积但心跳缺失时，不必等到清理阈值就提前发运维告警——把「runtime 掉线」
 * 的发现时间从分钟级压到心跳 TTL 级。
 */

import { sendOpsAlert } from '../infrastructure/alerts.js';
import { acquireRedisWorkerLock, getRedis } from '../infrastructure/redis.js';
import { logger } from '../infrastructure/logger.js';
import { processAiChatOutboxPayload } from './ipc-ai-chat-outbox-handler.js';
import {
  releaseGlobalAgentSlot,
  releasePerUserMeteredSlotByRequestId,
} from './ipc-worker.js';
import {
  AI_CHAT_OUTBOX_ORPHAN_MS,
  INBOX_STALL_FAIL_MS,
  INBOX_STALL_WARN_MS,
} from '../shared/timeout-chain.js';
import {
  buildAiChatErrorResponsePayload,
  type PendingInboxRequest,
} from './ipc-payloads.js';

/** 巡检运行间隔：每 1 分钟一次。 */
const SWEEP_INTERVAL_MS = 60 * 1000;
/** 告警阈值：堆积超过此时长只记日志，不动数据（从超时链导出）。 */
const WARN_THRESHOLD_MS = INBOX_STALL_WARN_MS;
/**
 * 自动清理阈值：从超时链派生（daemon 单请求硬超时 + 余量），避免误杀
 * "排在一条慢请求后面、暂时还没轮到"的正常消息。
 */
const FAIL_THRESHOLD_MS = INBOX_STALL_FAIL_MS;
const SWEEP_LOCK_KEY = 'inbox-stall-sweep:worker-lock';
/** 多实例分布式锁 TTL，略小于运行间隔，避免锁在下一轮开始前还没释放。 */
const SWEEP_LOCK_TTL_MS = 55 * 1000;
const INBOX_SCAN_MATCH = 'ipc:*:inbox*';
const AI_CHAT_OUTBOX_SCAN_MATCH = 'ipc:*:ai-chat:outbox';
const SCAN_COUNT = 200;
/**
 * 单个队列单轮最多清理的消息数：正常堆积（实测几十条）一轮即可清空；上限用于
 * 防止极端堆积时单队列清理耗时超过锁 TTL（`SWEEP_LOCK_TTL_MS`）导致锁在处理
 * 途中过期，剩余的留到下一轮继续。
 */
const MAX_CLEANUP_PER_QUEUE_PER_SWEEP = 200;

/** daemon 心跳 key 前缀（写入方见 apps/agent-runtime/src/daemon.ts）。 */
const AGENT_HEARTBEAT_KEY_PREFIX = 'agent:heartbeat:';

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

/** 按 MATCH 模式扫描 Redis keyspace，游标分批直到遍历完。 */
async function scanKeys(match: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await getRedis().scan(
      cursor,
      'MATCH',
      match,
      'COUNT',
      SCAN_COUNT,
    );
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

/**
 * 从 inbox 队列 key 解析 accountId。
 * 形如 `ipc:{accountId}:inbox` / `ipc:{accountId}:inbox:member`；
 * accountId 自身可含冒号（如 `web:{userId}`），故用前后缀剥离而非 split。
 */
function accountIdFromInboxKey(queueKey: string): string | null {
  if (!queueKey.startsWith('ipc:')) return null;
  const body = queueKey.slice('ipc:'.length);
  if (body.endsWith(':inbox:member')) {
    return body.slice(0, -':inbox:member'.length) || null;
  }
  if (body.endsWith(':inbox')) {
    return body.slice(0, -':inbox'.length) || null;
  }
  return null;
}

/**
 * 从 ai-chat outbox 队列 key 解析 accountId（`ipc:{accountId}:ai-chat:outbox`）。
 */
function accountIdFromAiChatOutboxKey(queueKey: string): string | null {
  if (!queueKey.startsWith('ipc:')) return null;
  const body = queueKey.slice('ipc:'.length);
  if (!body.endsWith(':ai-chat:outbox')) return null;
  return body.slice(0, -':ai-chat:outbox'.length) || null;
}

/**
 * 查询指定账号的本地 agent-runtime 是否有存活心跳。
 *
 * @param accountId 运行时账号 ID。
 * @returns 心跳 key 存在（TTL 未过期）时返回 true。
 */
async function hasAgentHeartbeat(accountId: string): Promise<boolean> {
  const value = await getRedis().get(
    `${AGENT_HEARTBEAT_KEY_PREFIX}${accountId}`,
  );
  return value !== null;
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

async function sweepInboxQueue(queueKey: string): Promise<void> {
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
      // 心跳升级：有堆积且 runtime 心跳缺失 → runtime 已掉线，无需干等清理阈值，
      // 立即发运维告警（告警模块内部按 kind 节流，不会每轮轰炸）。
      const accountId = accountIdFromInboxKey(queueKey);
      if (accountId && !(await hasAgentHeartbeat(accountId))) {
        void sendOpsAlert({
          kind: 'agent_heartbeat_missing',
          title: 'agent-runtime 疑似掉线：inbox 有堆积且心跳缺失',
          detail: `队列 ${queueKey} 最老消息已堆积 ${Math.round(ageMs / 1000)}s，且未检测到 runtime 心跳`,
          context: { queueKey, accountId, ageMs },
        });
      }
      return; // 最久的一条尚未到清理阈值，本队列本轮无可清理
    }

    if (!isRecoverableAiChatInboxPayload(payload)) {
      logger.warn(
        { queueKey, requestId: payload.requestId, ageMs, type: payload.type },
        'AI Chat: inbox 队列消息堆积超过清理阈值，但不是可识别的站内 AI Chat 消息，跳过自动清理',
      );
      // 微信等非 AI Chat 消息不能代处理（有发信副作用），但堆到清理阈值本身就是
      // 消费停滞的强信号，升级为运维告警而不是只留一行 warn 日志。
      void sendOpsAlert({
        kind: 'inbox_stall_unrecoverable',
        title: 'inbox 消息堆积超过清理阈值且无法自动清理',
        detail: `队列 ${queueKey} 队尾消息（type=${String(payload.type)}）已堆积 ${Math.round(ageMs / 60_000)} 分钟`,
        context: { queueKey, requestId: payload.requestId, ageMs },
      });
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
    void sendOpsAlert({
      kind: 'inbox_stall_cleanup',
      title: 'inbox 消息堆积超过清理阈值，已自动标记失败',
      detail: `队列 ${queueKey}，requestId=${requestId}，堆积 ${Math.round(ageMs / 60_000)} 分钟`,
      context: { queueKey, requestId, sessionId, ageMs },
    });
    cleaned += 1;
  }

  // 达到单轮上限仍未清空：剩余留待下一轮，避免单队列清理耗时超过锁 TTL。
  logger.warn(
    { queueKey, cleaned },
    'AI Chat: inbox 单队列单轮清理达到上限，剩余留待下一轮继续',
  );
}

/**
 * 巡检单个 ai-chat outbox 队列，代为消费无主（没有监听器）的滞留消息。
 *
 * 判定依据：outbox 消息在有监听器时毫秒级被消费；队尾消息年龄超过
 * `AI_CHAT_OUTBOX_ORPHAN_MS` 即断定当前没有消费者。逐条 popIfStillTail 原子
 * 弹出后走 `processAiChatOutboxPayload`（空 pending map）：
 * - 最终响应（type=response）：正常落库 + 推流（sessionId 从 payload 兜底），
 *   并释放该 requestId 占用的全局并发槽 / per-user metered 名额；
 *   计费预留因无本机 pending 不在此结算，由 billing-sweeper 按对话日志补收。
 * - 中间消息/进度（type=message/progress）：handler 内因无 pending 丢弃（transient
 *   内容，会话已无人观看，丢弃无害）。
 * - 解析不了的脏数据：直接弹出丢弃并记死信日志——真实监听器的行为也是
 *   解析失败即消费掉，这里保持一致，避免脏数据永久堵死队列。
 */
async function sweepAiChatOutboxQueue(queueKey: string): Promise<void> {
  const accountId = accountIdFromAiChatOutboxKey(queueKey);
  if (!accountId) return;

  let recovered = 0;
  while (recovered < MAX_CLEANUP_PER_QUEUE_PER_SWEEP) {
    const tail = await getRedis().lrange(queueKey, -1, -1);
    if (tail.length === 0) return;
    const raw = tail[0];

    let payload: unknown;
    let timestampMs = NaN;
    try {
      payload = JSON.parse(raw) as unknown;
      const ts = (payload as { timestamp?: unknown }).timestamp;
      timestampMs = typeof ts === 'string' ? Date.parse(ts) : NaN;
    } catch {
      payload = null;
    }

    if (payload !== null && Number.isFinite(timestampMs)) {
      const ageMs = Date.now() - timestampMs;
      if (ageMs < AI_CHAT_OUTBOX_ORPHAN_MS) {
        return; // 队尾最老的一条还很新 → 大概率有活跃消费者，本队列不动
      }
    }
    // 走到这里：消息已超无主阈值，或根本解析不出时间戳（脏数据按无主处理）。

    const popped = await popIfStillTail(queueKey, raw);
    if (!popped) {
      return; // 队尾变化说明有消费者恰好复活，让位
    }

    if (payload === null) {
      // 死信：保留原文前缀便于排障，避免静默丢失。
      logger.error(
        { queueKey, rawPreview: raw.slice(0, 200) },
        'AI Chat: outbox 无主消息无法解析，已作为死信丢弃',
      );
      recovered += 1;
      continue;
    }

    const requestId = (payload as { requestId?: unknown }).requestId;
    await processAiChatOutboxPayload(
      payload,
      accountId,
      new Map<string, PendingInboxRequest>(),
    )
      .then(async () => {
        // 该请求可能仍占着全局并发槽 / per-user 名额（提交方进程已死，没人释放），
        // 代消费成功后一并释放，不用等 30 分钟惰性回收。
        if (typeof requestId === 'string') {
          await releaseGlobalAgentSlot(requestId).catch(() => {});
          await releasePerUserMeteredSlotByRequestId(requestId).catch(() => {});
        }
        logger.warn(
          { queueKey, accountId, requestId },
          'AI Chat: 已代消费无主 outbox 消息（监听器缺失，可能因进程重启）',
        );
      })
      .catch((err) => {
        // 消息已弹出但处理失败：记死信日志保留上下文。与真实监听器的失败路径
        // 一致（消息同样已被 BRPOP 消费），不回塞队列避免死循环。
        logger.error(
          { queueKey, accountId, requestId, err, rawPreview: raw.slice(0, 200) },
          'AI Chat: 代消费无主 outbox 消息失败，已作为死信丢弃',
        );
      });

    void sendOpsAlert({
      kind: 'ai_chat_outbox_orphan',
      title: 'ai-chat outbox 存在无主滞留消息，已代为消费',
      detail: `队列 ${queueKey}（常见于 API 非优雅重启后遗留的响应）`,
      context: { queueKey, accountId, requestId },
    });
    recovered += 1;
  }

  logger.warn(
    { queueKey, recovered },
    'AI Chat: outbox 单队列单轮代消费达到上限，剩余留待下一轮继续',
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
      const inboxKeys = await scanKeys(INBOX_SCAN_MATCH);
      for (const key of inboxKeys) {
        try {
          await sweepInboxQueue(key);
        } catch (err) {
          logger.warn({ key, err }, 'inbox 堆积巡检：单个队列处理失败');
        }
      }
      const outboxKeys = await scanKeys(AI_CHAT_OUTBOX_SCAN_MATCH);
      for (const key of outboxKeys) {
        try {
          await sweepAiChatOutboxQueue(key);
        } catch (err) {
          logger.warn({ key, err }, 'outbox 无主巡检：单个队列处理失败');
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

/** 启动 inbox/outbox 堆积巡检后台任务。 */
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
      outboxOrphanMs: AI_CHAT_OUTBOX_ORPHAN_MS,
    },
    '启动 inbox/outbox 堆积巡检后台任务',
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
