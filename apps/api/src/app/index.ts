import { stopAgentScheduler } from '#runtime/agent-scheduler';
import {
  startAgentRequestRecovery,
  stopAgentRequestRecovery,
} from '#runtime/agent-request-recovery';
/**
 * FateClaw Runtime — 启动入口
 *
 * 只负责初始化和编排，具体逻辑分布在各模块中：
 * - paths.ts          启动期路径辅助
 * - account.ts        账号 CRUD
 * - message-handler.ts 消息处理 + prompt 构建
 * - poller.ts         iLink 长轮询
 * - ipc-worker.ts     Redis IPC 消息路由
 * - resident-agent.ts Agent 分发
 */

import { pathToFileURL } from 'url';

import { startApiServer } from '#interfaces/http/server';
import { initDatabase, closeDatabase } from '#infrastructure/db';
import {
  cleanupStaleLocalAgentsOnStartup,
  stopAllLocalAgents,
} from '#runtime/local-runner';
import { startIpcWorker } from '#runtime/ipc-worker';
import {
  startWechatRuntimeWorker,
  stopWechatRuntimeWorker,
} from '#runtime/wechat-runtime';
import { runRuntimeUpgrades } from '#runtime/runtime-upgrades';
import { connectRedis, disconnectRedis } from '#infrastructure/redis';
import { startRetentionWorker, stopRetentionWorker } from '#runtime/retention';
import {
  startBillingSweepWorker,
  stopBillingSweepWorker,
} from '#runtime/billing-sweeper';
import {
  startPiSessionHealthWorker,
  stopPiSessionHealthWorker,
} from '#runtime/pi-session-health-worker';
import {
  startInboxStallSweeper,
  stopInboxStallSweeper,
} from '#runtime/inbox-stall-sweeper';
import { logger } from '#infrastructure/logger';
import {
  startServiceStatusWorker,
  stopServiceStatusWorker,
} from '#runtime/service-status-worker';
import { seedOfficialSkillsFromRegistry } from '#infrastructure/paths';

// Re-export for CLI and external consumers
export {
  addAccount,
  removeAccount,
  listAccounts,
} from '#modules/account/account-service';

export async function main(): Promise<void> {
  logger.info('FateClaw 启动中...');
  cleanupStaleLocalAgentsOnStartup();

  await initDatabase();
  logger.info('数据库已初始化（PostgreSQL）');

  await seedOfficialSkillsFromRegistry();

  await connectRedis();
  logger.info('Redis 已连接');

  await runRuntimeUpgrades();
  startIpcWorker([]);
  await startWechatRuntimeWorker();

  // 启动数据保留策略后台任务（定时清理过期 trace_events）
  startRetentionWorker();
  // 启动计费兜底扫描任务（补结算取消/超时/重启遗留的未结算预留，防漏收）
  startBillingSweepWorker();
  // 启动 Pi session 健康维护任务（未启用时只定时检查后台配置）
  startPiSessionHealthWorker();
  // 启动 inbox 堆积巡检任务（发现账号级 agent-runtime 消费停滞并自动清理告警）
  startInboxStallSweeper();
  startAgentRequestRecovery();
  startServiceStatusWorker();

  await startApiServer();

  // 统一的优雅退出：SIGINT / SIGTERM / 显式 exit 都走同一条路径，
  // 顺序释放：进程 → 后台任务 → Redis → DB
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, '开始优雅退出');
    try {
      // 等待所有子进程真正退出（给足 daemon 的 30s drain 窗口，内部有等待上限），
      // 再断开 Redis/DB——否则子进程排空中的响应会因连接先被关闭而丢失。
      await stopAgentRequestRecovery();
      await stopServiceStatusWorker();
      await stopWechatRuntimeWorker();
      await stopAllLocalAgents();
      stopRetentionWorker();
      stopBillingSweepWorker();
      stopPiSessionHealthWorker();
      stopInboxStallSweeper();
      stopAgentScheduler();
      await disconnectRedis();
      await closeDatabase();
      logger.info('优雅退出完成');
    } catch (err) {
      logger.error({ err }, '优雅退出过程出错');
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  logger.info('FateClaw 运行中');
}

const isDirectRun =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, '致命错误');
    process.exit(1);
  });
}
