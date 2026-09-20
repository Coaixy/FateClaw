import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  connectRedis,
  disconnectRedis,
  getRedis,
  getBlockingRedis,
} from '../src/redis.js';

// Explicit disposable Redis only; never use the application's configured source.
const testUrl = process.env.FATECLAW_TEST_REDIS_URL;
describe.skipIf(!testUrl)('Redis connection isolation integration', () => {
  beforeAll(async () => {
    vi.stubEnv('REDIS_URL', testUrl!);
    await connectRedis();
  });
  afterAll(async () => {
    await disconnectRedis();
    vi.unstubAllEnvs();
  });

  it('runs controls before BRPOP completes and after the consumer disconnects', async () => {
    const prefix = `fateclaw:test:${randomUUID()}`;
    const queue = `${prefix}:queue`;
    const key = `${prefix}:control`;
    const commands = getRedis();
    const consumer = getBlockingRedis();
    let completed = false;
    try {
      const consumerId = String(await consumer.call('CLIENT', 'ID'));
      const waiting = consumer.brpop(queue, 1).then((result) => {
        completed = true;
        return result;
      });
      // Confirm BRPOP is active server-side before checking the independent client.
      await vi.waitFor(async () => {
        const clients = String(await commands.call('CLIENT', 'LIST'));
        const line = clients
          .split('\n')
          .find((value) => value.startsWith(`id=${consumerId} `));
        expect(line).toContain('cmd=brpop');
      });
      await commands.set(key, 'control');
      expect(await commands.get(key)).toBe('control');
      expect(await commands.publish(`${prefix}:events`, '{}')).toBe(0);
      expect(completed).toBe(false);
      await expect(waiting).resolves.toBeNull();

      const interrupted = consumer.brpop(queue, 30).catch((error) => error);
      consumer.disconnect();
      await interrupted;
      await commands.set(key, 'after-disconnect');
      expect(await commands.get(key)).toBe('after-disconnect');
    } finally {
      await commands.del(queue, key);
    }
  });
});
