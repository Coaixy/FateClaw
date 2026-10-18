import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { clients, createClient } = vi.hoisted(() => {
  const clients: TestRedisClient[] = [];
  class TestRedisClient {
    connect = vi.fn(async (): Promise<void> => {});
    quit = vi.fn(async () => 'OK');
    disconnect = vi.fn();
    duplicate = vi.fn((): TestRedisClient => new TestRedisClient());
    brpop = vi.fn(() => new Promise(() => {}));
    publish = vi.fn(async () => 1);
    set = vi.fn(async () => 'OK');
    rpop = vi.fn(async () => null);

    constructor() {
      clients.push(this);
    }
  }
  const createClient = () => new TestRedisClient();
  return { clients, createClient };
});

vi.mock('ioredis', () => ({
  Redis: vi.fn(function () {
    return createClient();
  }),
}));
vi.mock('#agent/io', () => ({ log: vi.fn() }));

import {
  connectRedis,
  disconnectRedis,
  getRedis,
  getBlockingRedis,
} from '#agent/redis';
import { Redis } from 'ioredis';

describe('runtime Redis connection lifecycle', () => {
  beforeEach(() => {
    clients.length = 0;
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:1');
  });

  afterEach(async () => {
    await disconnectRedis();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('bounds control commands while leaving only the consumer blocking', async () => {
    await connectRedis();
    expect(Redis).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        commandTimeout: 5_000,
        connectTimeout: 5_000,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      }),
    );
    expect(clients[0].duplicate).toHaveBeenCalledWith({
      commandTimeout: undefined,
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    });
  });

  it('cleans up both connections when consumer startup fails', async () => {
    const commands = createClient();
    const consumer = createClient();
    commands.duplicate.mockReturnValue(consumer);
    consumer.connect.mockRejectedValueOnce(
      new Error('synthetic connection failure'),
    );
    vi.mocked(Redis).mockImplementationOnce(function () {
      return commands as unknown as Redis;
    });
    await expect(connectRedis()).rejects.toThrow(
      'synthetic connection failure',
    );
    expect(commands.disconnect).toHaveBeenCalledTimes(1);
    expect(consumer.disconnect).toHaveBeenCalledTimes(1);
    expect(() => getRedis()).toThrow();
    expect(() => getBlockingRedis()).toThrow();
  });

  it('waits for the consumer before exposing ready clients', async () => {
    const commands = createClient();
    const consumer = createClient();
    commands.duplicate.mockReturnValue(consumer);
    let ready!: () => void;
    consumer.connect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    vi.mocked(Redis).mockImplementationOnce(function () {
      return commands as unknown as Redis;
    });
    const connecting = connectRedis();
    await Promise.resolve();
    expect(() => getRedis()).toThrow();
    expect(() => getBlockingRedis()).toThrow();
    ready();
    await connecting;
    expect(getRedis()).toBe(commands);
    expect(getBlockingRedis()).toBe(consumer);
  });

  it('keeps control traffic on a different connection from an outstanding BRPOP', async () => {
    await connectRedis();
    const consumer = getBlockingRedis();
    const commands = getRedis();
    expect(consumer).not.toBe(commands);
    void consumer.brpop('synthetic:inbox', 30);
    await expect(commands.publish('synthetic:stream', '{}')).resolves.toBe(1);
    await expect(commands.set('synthetic:heartbeat', '1')).resolves.toBe('OK');
    await expect(commands.rpop('synthetic:cancel')).resolves.toBeNull();
    expect(clients[1].publish).not.toHaveBeenCalled();
    await disconnectRedis();
    expect(clients[1].disconnect).toHaveBeenCalledTimes(1);
    expect(clients[1].quit).not.toHaveBeenCalled();
    expect(clients[0].quit).toHaveBeenCalledTimes(1);
  });

  it('bounds shutdown if the command connection cannot acknowledge QUIT', async () => {
    vi.useFakeTimers();
    await connectRedis();
    clients[0].quit.mockImplementation(() => new Promise(() => {}));
    const shutdown = disconnectRedis();
    await vi.advanceTimersByTimeAsync(5_000);
    await shutdown;
    expect(clients[0].disconnect).toHaveBeenCalledTimes(1);
    expect(() => getRedis()).toThrow();
    expect(() => getBlockingRedis()).toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
