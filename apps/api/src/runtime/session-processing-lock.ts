import { getRedis } from '#infrastructure/redis';

/**
 * 构造 AI Chat 会话忙碌锁的 Redis key。
 *
 * @param sessionId AI Chat 会话 ID。
 * @returns 对应的 Redis key。
 */
export function sessionProcessingLockKey(sessionId: string): string {
  return `session:processing:${sessionId}`;
}

/**
 * 抢占或续期当前请求拥有的会话忙碌锁。
 *
 * @param sessionId AI Chat 会话 ID；为空时直接返回 false。
 * @param requestId 锁 owner，请求 ID 必须与锁内值一致才允许续期。
 * @param ttlSeconds 锁 TTL 秒数。
 * @returns 抢占空锁或续期自有锁成功时返回 true；锁被其他请求持有时返回 false。
 */
export async function claimOrRefreshSessionProcessingLock(
  sessionId: string | undefined,
  requestId: string | undefined,
  ttlSeconds: number,
): Promise<boolean> {
  if (!sessionId || !requestId) return false;
  const claimed = await getRedis().eval(
    `
    local current = redis.call('GET', KEYS[1])
    if current == ARGV[1] then
      return redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
    end
    if not current then
      redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
      return 1
    end
    return 0
    `,
    1,
    sessionProcessingLockKey(sessionId),
    requestId,
    ttlSeconds,
  );
  return claimed === 1;
}

/**
 * 仅释放当前请求拥有的会话忙碌锁。
 *
 * @param sessionId AI Chat 会话 ID；为空时不操作。
 * @param requestId 期望的锁 owner，请求 ID 必须与锁内值一致才会删除。
 * @returns 实际删除 Redis key 时返回 true，否则返回 false。
 */
export async function releaseSessionProcessingLock(
  sessionId: string | undefined,
  requestId: string | undefined,
): Promise<boolean> {
  if (!sessionId || !requestId) return false;
  const released = await getRedis().eval(
    `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
    `,
    1,
    sessionProcessingLockKey(sessionId),
    requestId,
  );
  return released === 1;
}
