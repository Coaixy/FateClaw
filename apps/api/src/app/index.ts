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
import {
  initDatabase,
  closeDatabase,
  getEnabledAccounts,
} from '../infrastructure/db.js';
import {
  cleanupStaleLocalAgentsOnStartup,
  stopAllLocalAgents,
} from '../runtime/local-runner.js';
import { addAccountListener, startIpcWorker } from '../runtime/ipc-worker.js';
import { startAccountPolling } from '../runtime/poller.js';
import { connectRedis, disconnectRedis } from '../infrastructure/redis.js';
import {
  startRetentionWorker,
  stopRetentionWorker,
} from '../runtime/retention.js';
import {
  startBillingSweepWorker,
  stopBillingSweepWorker,
} from '../runtime/billing-sweeper.js';
import {
  startPiSessionHealthWorker,
  stopPiSessionHealthWorker,
} from '../runtime/pi-session-health-worker.js';
import {
  startInboxStallSweeper,
  stopInboxStallSweeper,
} from '../runtime/inbox-stall-sweeper.js';
import { logger } from '../infrastructure/logger.js';
import { seedOfficialSkillsFromRegistry } from '../infrastructure/paths.js';
import { getRuntimeEntitlementSnapshot } from '../modules/billing/entitlements.js';

// Re-export for CLI and external consumers
export {
  addAccount,
  removeAccount,
  listAccounts,
} from '../modules/account/account-service.js';

/**
 * 热激活新账号入口。
 * 会员微信 Claw 账号绑定后，立即启动轮询和 IPC 监听。
 */
export async function activateAccount(
  account: import('../shared/types.js').Account,
): Promise<void> {
  // 微信 Claw 账号监听常驻（pinned），不参与站内监听的空闲回收。
  addAccountListener(account.id, { pinned: true });
  await startAccountPolling(account);
}

export async function main(): Promise<void> {
  logger.info('FateClaw 启动中...');
  cleanupStaleLocalAgentsOnStartup();

  await initDatabase();
  logger.info('数据库已初始化（PostgreSQL）');

  await seedOfficialSkillsFromRegistry();

  await connectRedis();
  logger.info('Redis 已连接');

  const enabledAccounts = await getEnabledAccounts();
  const memberAccounts: string[] = [];
  for (const account of enabledAccounts) {
    if (!account.owner_id) continue;
    const entitlement = await getRuntimeEntitlementSnapshot(account.owner_id);
    if (!entitlement.canUseWechatClaw) continue;
    memberAccounts.push(account.id);
    void startAccountPolling(account).catch((err) => {
      logger.error({ accountId: account.id, err }, '微信 Claw 轮询启动失败');
    });
  }
  startIpcWorker(memberAccounts);
  logger.info(
    { accounts: memberAccounts.length },
    '会员微信 Claw listener 已启动',
  );

  // 启动数据保留策略后台任务（定时清理过期 trace_events）
  startRetentionWorker();
  // 启动计费兜底扫描任务（补结算取消/超时/重启遗留的未结算预留，防漏收）
  startBillingSweepWorker();
  // 启动 Pi session 健康维护任务（未启用时只定时检查后台配置）
  startPiSessionHealthWorker();
  // 启动 inbox 堆积巡检任务（发现账号级 agent-runtime 消费停滞并自动清理告警）
  startInboxStallSweeper();

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
      await stopAllLocalAgents();
      stopRetentionWorker();
      stopBillingSweepWorker();
      stopPiSessionHealthWorker();
      stopInboxStallSweeper();
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
