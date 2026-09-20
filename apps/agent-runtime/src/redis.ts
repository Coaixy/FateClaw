/**
 * 容器侧 Redis 单例。
 * 从 REDIS_URL 环境变量连接。
 */
import { Redis } from 'ioredis';

import { log } from './io.js';

let redis: Redis | null = null;
let blockingRedis: Redis | null = null;

export async function connectRedis(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('缺少 REDIS_URL 环境变量');
  }

  const commands = new Redis(url, {
    maxRetriesPerRequest: 1,
    commandTimeout: 5_000,
    connectTimeout: 5_000,
    enableOfflineQueue: false,
    enableReadyCheck: true,
    lazyConnect: true,
  });

  // Redis queues all later commands behind BRPOP on the same connection.
  // In ioredis, zero is an immediate timeout; undefined disables the inherited deadline.
  const consumer = commands.duplicate({
    commandTimeout: undefined,
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
  });
  try {
    await Promise.all([commands.connect(), consumer.connect()]);
  } catch (error) {
    commands.disconnect();
    consumer.disconnect();
    throw error;
  }
  redis = commands;
  blockingRedis = consumer;
  log('Redis 已连接');
}

export function getRedis(): Redis {
  if (!redis) {
    throw new Error('Redis 尚未连接，请先调用 connectRedis()');
  }
  return redis;
}

export function getBlockingRedis(): Redis {
  if (!blockingRedis) {
    throw new Error('Blocking Redis connection is not initialized');
  }
  return blockingRedis;
}

export async function disconnectRedis(): Promise<void> {
  // QUIT on the consumer would itself wait behind an outstanding BRPOP.
  blockingRedis?.disconnect();
  blockingRedis = null;
  const commands = redis;
  redis = null;
  if (!commands) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      commands.quit(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    commands.disconnect();
  }
  log('Redis 已断开');
}
