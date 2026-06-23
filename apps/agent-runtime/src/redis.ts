/**
 * 容器侧 Redis 单例。
 * 从 REDIS_URL 环境变量连接。
 */
import { Redis } from 'ioredis';

import { log } from './io.js';

let redis: Redis | null = null;
// 阻塞监听(brpop)专用连接。ioredis 单条连接顺序处理命令:brpop 阻塞期间,排在它后面
// 的 publish/lpush 在服务端根本不会被执行,直到 brpop 返回。daemon 主循环在并发≥2 时会
// 一边跑任务一边用同一条连接 brpop 抓下一个任务,导致这一轮的流式 token(publish)全部被
// 憋住、回合结束才一次性涌出(表现为"服务器憋完一次吐出")。故把阻塞监听物理隔到这条连接,
// 主连接 getRedis() 只跑非阻塞命令(publish/lpush/rpop),永不被阻塞命令占用。
let blockingRedis: Redis | null = null;

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

  // 与主连接同配置、物理隔离的阻塞监听连接;maxRetriesPerRequest=null 对阻塞命令同样必要。
  blockingRedis = redis.duplicate();
  await blockingRedis.connect();

  log('Redis 已连接（含阻塞监听专用连接）');
}

export function getRedis(): Redis {
  if (!redis) {
    throw new Error('Redis 尚未连接，请先调用 connectRedis()');
  }
  return redis;
}

/**
 * 获取阻塞命令(如 brpop)专用的 Redis 连接。
 *
 * 与 {@link getRedis} 返回的主连接物理隔离:主连接只跑非阻塞命令(publish/lpush/rpop),
 * 不会被阻塞命令占用,从而保证流式 token 的 publish 在任意账号并发下都能即时下发。
 *
 * @returns 仅供 brpop 等阻塞监听使用的 Redis 连接。
 * @throws 当尚未调用 {@link connectRedis} 时抛出。
 */
export function getBlockingRedis(): Redis {
  if (!blockingRedis) {
    throw new Error('Redis 尚未连接，请先调用 connectRedis()');
  }
  return blockingRedis;
}

export async function disconnectRedis(): Promise<void> {
  if (blockingRedis) {
    await blockingRedis.quit();
    blockingRedis = null;
  }
  if (redis) {
    await redis.quit();
    redis = null;
    log('Redis 已断开');
  }
}
