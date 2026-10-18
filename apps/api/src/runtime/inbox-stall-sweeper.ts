import {
  claimAiChatResult,
  acknowledgeAiChatResult,
  quarantineAiChatResult,
  processingOutboxKey,
} from './reliable-ai-chat-outbox.js';
import { decodeRuntimeIpc, encodeRuntimeIpc } from './ipc-security.js';
import { InvalidRuntimeIpcError } from '@fateclaw/contracts/runtime-ipc';
/**
 * Recover abandoned AI Chat transport work. Durable admissions own execution
 * recovery; legacy expired inbox requests atomically enqueue a failure before
 * removal. Results remain in a processing list until database delivery succeeds.
 * WeChat outboxes are excluded because external sends are not safely replayable.
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
  InvalidAiChatPayloadError,
  buildAiChatErrorResponsePayload,
  type PendingInboxRequest,
} from './ipc-payloads.js';

/** 巡检运行间隔：每 1 分钟一次。 */
const SWEEP_INTERVAL_MS = 60 * 1000;
/** 告警阈值：堆积超过此时长只记日志，不动数据（从超时链导出）。 */
const WARN_THRESHOLD_MS = INBOX_STALL_WARN_MS;
/**
 * 自动清理阈值：从超时链派生（daemon 请求绝对上限 + 余量），避免误杀
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
  executionId?: string;
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
      const account = accountIdFromInboxKey(queueKey);
      if (!account) return;
      // Expired input is inspected only to retire its transport copy, never executed.
      payload = JSON.parse(
        decodeRuntimeIpc(account, queueKey, raw, true),
      ) as StaleInboxPayload;
    } catch {
      if (!(await popIfStillTail(queueKey, raw))) return;
      cleaned += 1;
      continue;
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

    if (typeof payload.executionId === 'string') {
      // Durable admission owns recovery; this expired Redis copy must not finalize usage.
      if (!(await popIfStillTail(queueKey, raw))) return;
      cleaned += 1;
      continue;
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

    const failure = buildAiChatErrorResponsePayload({
      accountId,
      requestId,
      sessionId,
      userMessageId,
      ownerUserId,
      publicErrorText: text,
      error: `inbox 消息堆积超过 ${Math.round(FAIL_THRESHOLD_MS / 60_000)} 分钟未被消费，判定为处理超时`,
      reasonCode: 'inbox_stall_timeout',
    });
    // Persist the failure envelope before removing the legacy inbox copy.
    const moved = await getRedis().eval(
      `
      if redis.call('LINDEX', KEYS[1], -1) ~= ARGV[1] then return 0 end
      redis.call('LPUSH', KEYS[2], ARGV[2])
      redis.call('rpop', KEYS[1])
      return 1
    `,
      2,
      queueKey,
      `ipc:${accountId}:ai-chat:outbox`,
      raw,
      encodeRuntimeIpc(
        accountId,
        `ipc:${accountId}:ai-chat:outbox`,
        JSON.stringify(failure),
      ),
    );
    if (moved !== 1) return;
    await processAiChatOutboxPayload(
      failure,
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

/** Retry orphaned deliveries without removing their transport copy before commit. */
async function sweepAiChatOutboxQueue(queueKey: string): Promise<void> {
  const accountId = accountIdFromAiChatOutboxKey(queueKey);
  if (!accountId) return;
  for (
    let recovered = 0;
    recovered < MAX_CLEANUP_PER_QUEUE_PER_SWEEP;
    recovered += 1
  ) {
    const processing = await getRedis().lrange(
      processingOutboxKey(queueKey),
      -1,
      -1,
    );
    const tail = processing.length
      ? processing
      : await getRedis().lrange(queueKey, -1, -1);
    if (!tail.length) return;
    try {
      const timestamp = Date.parse(
        JSON.parse(decodeRuntimeIpc(accountId, queueKey, tail[0])).timestamp,
      );
      if (
        !processing.length &&
        Number.isFinite(timestamp) &&
        Date.now() - timestamp < AI_CHAT_OUTBOX_ORPHAN_MS
      )
        return;
    } catch {
      /* Invalid envelopes move to quarantine below. */
    }
    const raw = await claimAiChatResult(queueKey);
    if (raw === null) return;
    let payload: unknown;
    try {
      payload = JSON.parse(decodeRuntimeIpc(accountId, queueKey, raw));
    } catch {
      await quarantineAiChatResult(queueKey, raw);
      logger.error({ queueKey }, 'Invalid AI Chat result quarantined');
      continue;
    }
    try {
      await processAiChatOutboxPayload(
        payload,
        accountId,
        new Map<string, PendingInboxRequest>(),
      );
      await acknowledgeAiChatResult(queueKey, raw);
      const requestId = (payload as { requestId?: unknown }).requestId;
      if (typeof requestId === 'string') {
        await releaseGlobalAgentSlot(requestId);
        await releasePerUserMeteredSlotByRequestId(requestId);
      }
    } catch (err) {
      if (
        err instanceof InvalidAiChatPayloadError ||
        err instanceof InvalidRuntimeIpcError
      ) {
        await quarantineAiChatResult(queueKey, raw);
        continue;
      }
      logger.error({ queueKey, err }, 'AI Chat result retained for retry');
      return;
    }
  }
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
    const lock = await acquireRedisWorkerLock(
      SWEEP_LOCK_KEY,
      SWEEP_LOCK_TTL_MS,
    );
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
      const outboxKeys = new Set([
        ...(await scanKeys(AI_CHAT_OUTBOX_SCAN_MATCH)),
        ...(await scanKeys(`${AI_CHAT_OUTBOX_SCAN_MATCH}:processing`)).map(
          (key) => key.slice(0, -':processing'.length),
        ),
      ]);
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
