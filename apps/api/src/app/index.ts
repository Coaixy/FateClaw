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

import { startApiServer } from '../interfaces/http/server.js';
import { initDatabase, closeDatabase } from '../infrastructure/db.js';
import { stopAllLocalAgents } from '../runtime/local-runner.js';
import { startIpcWorker } from '../runtime/ipc-worker.js';
import { connectRedis, disconnectRedis } from '../infrastructure/redis.js';
import {
  startRetentionWorker,
  stopRetentionWorker,
} from '../runtime/retention.js';
import { logger } from '../infrastructure/logger.js';
import { seedOfficialSkillsFromDir } from '../infrastructure/paths.js';

// Re-export for CLI and external consumers
export {
  addAccount,
  removeAccount,
  listAccounts,
} from '../modules/account/account-service.js';

/**
 * 热激活新账号入口。
 * 当前微信设备运行入口关闭，因此只保留显式日志，避免调用方误判为已启动轮询。
 */
export async function activateAccount(
  account: import('../shared/types.js').Account,
): Promise<void> {
  logger.warn(
    { accountId: account.id },
    '微信设备运行入口暂时关闭，跳过热激活',
  );
}

export async function main(): Promise<void> {
  logger.info('FateClaw 启动中...');

  await initDatabase();
  logger.info('数据库已初始化（PostgreSQL）');

  await seedOfficialSkillsFromDir();

  await connectRedis();
  logger.info('Redis 已连接');

  startIpcWorker([]);
  logger.warn('微信设备 listener/poller 暂时关闭');

  // 启动数据保留策略后台任务（定时清理过期 trace_events）
  startRetentionWorker();

  await startApiServer();

  // 统一的优雅退出：SIGINT / SIGTERM / 显式 exit 都走同一条路径，
  // 顺序释放：进程 → 后台任务 → Redis → DB
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, '开始优雅退出');
    try {
      stopAllLocalAgents();
      stopRetentionWorker();
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
