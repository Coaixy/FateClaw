/**
 * 宿主侧 Redis 单例。
 * 优先使用 config 导出的 REDIS_URL，回退到 process.env.REDIS_URL。
 */
import { Redis } from 'ioredis';

import { REDIS_URL } from './config.js';
import { logger } from './logger.js';

let redis: Redis | null = null;

export async function connectRedis(): Promise<void> {
  const url = REDIS_URL || process.env.REDIS_URL;
  if (!url) {
    throw new Error('缺少 REDIS_URL 配置');
  }

  redis = new Redis(url, {
    maxRetriesPerRequest: null, // BRPOP 需要
    enableReadyCheck: true,
    lazyConnect: true,
  });

  await redis.connect();
  logger.info('Redis 已连接');
}

export function getRedis(): Redis {
  if (!redis) {
    throw new Error('Redis 尚未连接，请先调用 connectRedis()');
  }
  return redis;
}

export async function disconnectRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
    logger.info('Redis 已断开');
  }
}
