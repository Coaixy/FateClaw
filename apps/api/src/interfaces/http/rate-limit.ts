/**
 * 通用指数退避限流器（Redis 持久化）
 *
 * 用于保护敏感端点（如 admin 密钥校验、登录、注册）免受脚本爆破：
 * 每次失败后按 2^fails 秒退避，封顶 10 分钟。
 * 成功时清除该 key 的限流状态。
 *
 * 状态存于 Redis，进程重启或多实例部署后限流仍然生效。
 */

import { getRedis } from '../../infrastructure/redis.js';

const MAX_BACKOFF_MS = 10 * 60 * 1000; // 10 分钟封顶
const BASE_BACKOFF_MS = 1000; // 2^1 = 2s 起步
const ENTRY_TTL_SEC = 24 * 60 * 60; // 24h 自动过期，避免 key 无限增长

function buildKey(key: string): { failsKey: string; nextKey: string } {
  return {
    failsKey: `ratelimit:${key}:fails`,
    nextKey: `ratelimit:${key}:next`,
  };
}

/**
 * 检查 key 当前是否允许通过。
 */
export async function rateLimitCheck(key: string): Promise<{
  allowed: boolean;
  retryAfterMs?: number;
}> {
  const { nextKey } = buildKey(key);
  const raw = await getRedis().get(nextKey);
  if (!raw) return { allowed: true };
  const nextAllowedAt = parseInt(raw, 10);
  if (!Number.isFinite(nextAllowedAt)) return { allowed: true };
  const now = Date.now();
  if (now >= nextAllowedAt) return { allowed: true };
  return { allowed: false, retryAfterMs: nextAllowedAt - now };
}

/**
 * 记录一次失败，按指数退避计算下次允许通过的时间。
 */
export async function rateLimitRecordFail(key: string): Promise<void> {
  const { failsKey, nextKey } = buildKey(key);
  const fails = await getRedis().incr(failsKey);
  await getRedis().expire(failsKey, ENTRY_TTL_SEC);
  // 2s, 4s, 8s, 16s, ... 封顶 10 分钟
  const backoff = Math.min(
    BASE_BACKOFF_MS * Math.pow(2, fails),
    MAX_BACKOFF_MS,
  );
  const nextAllowedAt = Date.now() + backoff;
  await getRedis().set(nextKey, String(nextAllowedAt), 'EX', ENTRY_TTL_SEC);
}

/**
 * 成功时清除限流记录。
 */
export async function rateLimitClear(key: string): Promise<void> {
  const { failsKey, nextKey } = buildKey(key);
  await getRedis().del(failsKey, nextKey);
}
