/**
 * 容器侧 Redis 单例。
 * 从 REDIS_URL 环境变量连接。
 */
import { Redis } from 'ioredis';

import { log } from './io.js';

let redis: Redis | null = null;

export async function connectRedis(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('缺少 REDIS_URL 环境变量');
  }

  redis = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  });

  await redis.connect();
  log('Redis 已连接');
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
    log('Redis 已断开');
  }
}
