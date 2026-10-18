import { getRedis } from '#infrastructure/redis';
import type { Redis } from 'ioredis';

export function processingOutboxKey(queue: string): string {
  return `${queue}:processing`;
}

/** Keep the transport copy until the database delivery boundary succeeds. */
export async function claimAiChatResult(
  queue: string,
  blocking?: Pick<Redis, 'blmove'>,
): Promise<string | null> {
  const redis = getRedis();
  const processing = processingOutboxKey(queue);
  const existing = await redis.lindex(processing, -1);
  return (
    existing ??
    (blocking
      ? blocking.blmove(queue, processing, 'RIGHT', 'LEFT', 1)
      : redis.rpoplpush(queue, processing))
  );
}

export async function acknowledgeAiChatResult(
  queue: string,
  raw: string,
): Promise<void> {
  await getRedis().lrem(processingOutboxKey(queue), 1, raw);
}

export async function quarantineAiChatResult(
  queue: string,
  raw: string,
): Promise<void> {
  // Redis transactions do not roll back successful commands after a command error.
  // A failed quarantine write must leave the processing copy available for retry.
  await getRedis().eval(
    `local pending = redis.call('lrange', KEYS[1], 0, -1)
     for _, value in ipairs(pending) do
       if value == ARGV[1] then
         redis.call('lpush', KEYS[2], ARGV[1])
         return redis.call('lrem', KEYS[1], 1, ARGV[1])
       end
     end
     return 0`,
    2,
    processingOutboxKey(queue),
    `${queue}:invalid`,
    raw,
  );
}
