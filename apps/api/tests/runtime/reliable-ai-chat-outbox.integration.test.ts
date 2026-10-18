import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
const { holder } = vi.hoisted(() => ({
  holder: { redis: undefined as unknown },
}));
vi.mock('../../src/infrastructure/redis.js', () => ({
  getRedis: () => holder.redis,
}));
import {
  acknowledgeAiChatResult,
  claimAiChatResult,
  quarantineAiChatResult,
} from '../../src/runtime/reliable-ai-chat-outbox.js';

const url = process.env.FATECLAW_TEST_REDIS_URL;
describe.skipIf(!url)('reliable results with real Redis', () => {
  let redis: Redis;
  const queue = `test:fateclaw:${randomUUID()}:outbox`;
  const processing = `${queue}:processing`;
  const invalid = `${queue}:invalid`;
  beforeAll(() => {
    redis = new Redis(url!, { maxRetriesPerRequest: 1 });
    holder.redis = redis;
  });
  beforeEach(async () => {
    await redis.del(queue, processing, invalid);
  });
  afterAll(async () => {
    await redis.del(queue, processing, invalid);
    await redis.quit();
  });

  it('keeps a claimed result through client reconnect until successful acknowledgement', async () => {
    await redis.lpush(queue, 'first', 'second');
    expect(await claimAiChatResult(queue)).toBe('first');
    expect(await redis.lrange(processing, 0, -1)).toEqual(['first']);
    await redis.quit();
    redis = new Redis(url!, { maxRetriesPerRequest: 1 });
    holder.redis = redis;
    expect(await claimAiChatResult(queue)).toBe('first');
    await acknowledgeAiChatResult(queue, 'first');
    expect(await claimAiChatResult(queue)).toBe('second');
  });
  it('wakes the reliable AI consumer while an unrelated queue remains blocked', async () => {
    const blocking = redis.duplicate();
    const unrelated = redis.duplicate();
    try {
      const ordinary = unrelated.brpop(`${queue}:unrelated`, 1);
      const claimed = claimAiChatResult(queue, blocking);
      await redis.lpush(queue, 'synthetic immediate result');
      expect(
        await Promise.race([
          claimed,
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error('AI result was delayed by the unrelated queue'),
                ),
              500,
            ),
          ),
        ]),
      ).toBe('synthetic immediate result');
      expect(await redis.lrange(processing, 0, -1)).toEqual([
        'synthetic immediate result',
      ]);
      await acknowledgeAiChatResult(queue, 'synthetic immediate result');
      await ordinary;
    } finally {
      blocking.disconnect();
      unrelated.disconnect();
    }
  });
  it('never loses messages under concurrent claims and duplicate acknowledgements', async () => {
    await redis.lpush(queue, 'first', 'second');
    const claims = await Promise.all([
      claimAiChatResult(queue),
      claimAiChatResult(queue),
    ]);
    const outstanding = new Set([
      ...(await redis.lrange(queue, 0, -1)),
      ...(await redis.lrange(processing, 0, -1)),
    ]);
    expect(outstanding).toEqual(new Set(['first', 'second']));
    for (const raw of claims)
      if (raw) await acknowledgeAiChatResult(queue, raw);
    for (const raw of claims)
      if (raw) await acknowledgeAiChatResult(queue, raw);
    for (
      let remaining = await claimAiChatResult(queue);
      remaining !== null;
      remaining = await claimAiChatResult(queue)
    ) {
      await acknowledgeAiChatResult(queue, remaining);
    }
    expect(await redis.llen(processing)).toBe(0);
  });
  it('moves malformed messages into quarantine without exposing their contents', async () => {
    await redis.lpush(queue, '{malformed');
    expect(await claimAiChatResult(queue)).toBe('{malformed');
    await quarantineAiChatResult(queue, '{malformed');
    await quarantineAiChatResult(queue, '{malformed');
    expect(await redis.lrange(invalid, 0, -1)).toEqual(['{malformed']);
    expect(await redis.llen(processing)).toBe(0);
  });
  it('retains processing copy when the quarantine destination cannot accept it', async () => {
    await redis.lpush(processing, '{malformed');
    await redis.set(invalid, 'synthetic wrong type');
    await expect(quarantineAiChatResult(queue, '{malformed')).rejects.toThrow();
    expect(await redis.lrange(processing, 0, -1)).toEqual(['{malformed']);
  });
});
