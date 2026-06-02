/**
 * 轻量 API 开发入口 — 仅启动 DB + Redis + API Server
 *
 * 跳过：Docker 容器、iLink 轮询、IPC Worker、定时任务调度、凭据代理
 * 用途：前端开发调试、API 接口测试
 *
 * 使用：pnpm run dev:api-only
 */

import { startApiServer } from '../interfaces/http/server.js';
import { initDatabase, closeDatabase } from '../infrastructure/db.js';
import { connectRedis, disconnectRedis } from '../infrastructure/redis.js';
import { logger } from '../infrastructure/logger.js';
import { seedOfficialSkillsFromRegistry } from '../infrastructure/paths.js';

async function main(): Promise<void> {
  logger.info('API-only 开发模式启动中...');

  await initDatabase();
  logger.info('数据库已连接');

  await seedOfficialSkillsFromRegistry();

  await connectRedis();
  logger.info('Redis 已连接');

  await startApiServer();
  logger.info('API 服务已就绪 — 跳过容器/轮询/IPC/调度');

  const shutdown = async () => {
    await disconnectRedis();
    await closeDatabase();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown().catch(() => process.exit(1)));
  process.once('SIGTERM', () => shutdown().catch(() => process.exit(1)));
}

main().catch((err) => {
  logger.error({ err }, '致命错误');
  process.exit(1);
});
