import { setTimeout as sleep } from 'node:timers/promises';
import { closeAgentDb, getAgentAccountConcurrency } from './agent-db.js';
import { initContext } from './context.js';
import {
  deliverDurableResult,
  replayDurableResults,
} from './durable-execution.js';
import {
  cleanupExpiredPendingCancelRequests,
  drainCancelRequests,
} from './inbox-cancellation.js';
import { createInboxConsumer } from './inbox-consumer.js';
import {
  buildFatalOutboxResponse,
  processInboxMessage,
  pushEncryptedOutbox,
  type InboxRequestState,
} from './inbox-request.js';
import { log } from './io.js';
import {
  connectRedis,
  disconnectRedis,
  getBlockingRedis,
  getRedis,
} from './redis.js';

// 存活心跳：周期性写 `agent:heartbeat:{accountId}`（带 TTL）。宿主侧巡检任务
// （inbox-stall-sweeper）用它把「runtime 掉线」的发现时间从 inbox 堆积的分钟级
// 压到心跳 TTL 级；事件循环被同步阻塞（如灾难性正则回溯）时心跳会自然停跳，
// 也能被同一机制发现。优雅退出时主动删除 key，避免误报。
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TTL_MS = 30_000;
const SHUTDOWN_DRAIN_MS = 30_000;

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
  const inboxRedis = getBlockingRedis();
  let replayInFlight = false;
  const replay = async () => {
    if (replayInFlight) return;
    replayInFlight = true;
    try {
      await replayDurableResults(ctx.accountId, pushEncryptedOutbox);
    } catch {
      log('Result spool replay failed; retained for next attempt');
    } finally {
      replayInFlight = false;
    }
  };
  void replay();
  const replayTimer = setInterval(() => {
    void replay();
  }, 10_000);
  replayTimer.unref();

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
  const requests: InboxRequestState = {
    activeSessions: new Map(),
    pendingCancelRequests: new Map(),
    activeRequests: new Map(),
  };
  const inbox = createInboxConsumer({
    accountId: ctx.accountId,
    getConcurrency: getAgentAccountConcurrency,
    pop: (memberQueue, queue, timeout) =>
      inboxRedis.brpop(memberQueue, queue, timeout),
    requeue: (queue, encrypted) => redis.lpush(queue, encrypted),
    processMessage: (raw) => processInboxMessage(ctx.accountId, raw, requests),
  });

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
      for (const [requestId, { request, scope }] of requests.activeRequests) {
        try {
          const errorResponse = buildFatalOutboxResponse(
            kind,
            detail,
            request,
            scope,
          );
          await deliverDurableResult(
            request,
            errorResponse,
            pushEncryptedOutbox,
          );
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
    await inbox.stopAndDrain(SHUTDOWN_DRAIN_MS);
    // 优雅退出：停跳并主动删除心跳 key，避免宿主侧把正常回收误报为掉线。
    clearInterval(heartbeatTimer);
    clearInterval(replayTimer);
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
          requests.activeSessions,
          requests.pendingCancelRequests,
          redis,
        );
        cleanupExpiredPendingCancelRequests(requests.pendingCancelRequests);
      } catch (error) {
        log(
          `cancel drain 循环出错，将继续重试: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await sleep(250);
    }
  })();

  log(
    `常驻 agent 已启动，账号 ${ctx.accountId}，通过 Redis BRPOP 监听，并发=${await getAgentAccountConcurrency()}`,
  );

  await inbox.run();
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
