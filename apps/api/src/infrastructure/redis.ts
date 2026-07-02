/**
 * 宿主侧 Redis 单例。
 * 优先使用 config 导出的 REDIS_URL，回退到 process.env.REDIS_URL。
 */
import crypto from 'node:crypto';

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

/**
 * 获取一个多实例分布式 worker 锁（Redis `SET key token PX ttl NX`）。
 *
 * 多个 API 实例跑同一个定时任务时，用它保证同一轮只有一个实例真正执行。
 * 返回的 `release` 只删自己 token 持有的锁（compare-and-del Lua 脚本），
 * 避免锁到期后被其他实例重新获取、自己再误删对方的锁；即使持有者崩溃，
 * 锁也会在 TTL 后自动释放，不会永久卡死。
 *
 * @param lockKey 锁的 Redis key，不同任务用不同 key。
 * @param ttlMs 锁 TTL（毫秒）。
 * @returns 抢到锁返回 `{ release }`；已被其他实例持有返回 `null`。
 */
export async function acquireRedisWorkerLock(
  lockKey: string,
  ttlMs: number,
): Promise<{ release: () => Promise<void> } | null> {
  const token = crypto.randomUUID();
  const acquired = await getRedis().set(lockKey, token, 'PX', ttlMs, 'NX');
  if (acquired !== 'OK') {
    return null;
  }

  return {
    release: async () => {
      // 只释放自己持有的锁，避免锁过期后误删其他实例新拿到的锁。
      await getRedis().eval(
        `if redis.call("get", KEYS[1]) == ARGV[1] then
           return redis.call("del", KEYS[1])
         end
         return 0`,
        1,
        lockKey,
        token,
      );
    },
  };
}
