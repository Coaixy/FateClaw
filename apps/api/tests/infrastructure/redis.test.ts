import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { client, constructor } = vi.hoisted(() => ({
  client: { connect: vi.fn(), quit: vi.fn(), disconnect: vi.fn() },
  constructor: vi.fn(),
}));
vi.mock('ioredis', () => ({
  Redis: vi.fn(function (...args: unknown[]) {
    constructor(...args);
    return client;
  }),
}));
vi.mock('../../src/infrastructure/config.js', () => ({
  REDIS_URL: 'redis://127.0.0.1:1',
}));
vi.mock('../../src/infrastructure/logger.js', () => ({
  logger: { info: vi.fn() },
}));
import {
  connectRedis,
  disconnectRedis,
  getRedis,
} from '../../src/infrastructure/redis.js';
describe('API Redis lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.connect.mockResolvedValue(undefined);
    client.quit.mockResolvedValue('OK');
  });
  afterEach(async () => {
    await disconnectRedis();
    vi.useRealTimers();
  });
  it('fails commands within a finite deadline instead of keeping an offline queue', async () => {
    await connectRedis();
    expect(constructor).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        commandTimeout: 5_000,
        connectTimeout: 5_000,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      }),
    );
  });
  it('cleans up failed startup without exposing a broken singleton', async () => {
    client.connect.mockRejectedValueOnce(new Error('connection failed'));
    await expect(connectRedis()).rejects.toThrow('connection failed');
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(getRedis).toThrow();
  });
  it('forces disconnect after five seconds when QUIT never completes', async () => {
    vi.useFakeTimers();
    await connectRedis();
    client.quit.mockImplementationOnce(() => new Promise(() => {}));
    const stop = disconnectRedis();
    await vi.advanceTimersByTimeAsync(5_000);
    await stop;
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(getRedis).toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
