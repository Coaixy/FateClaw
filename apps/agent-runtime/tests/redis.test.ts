import { beforeEach, describe, expect, it, vi } from 'vitest';

// 记录所有被 new 出来的 FakeRedis 实例,便于断言连接拓扑。
const { instances } = vi.hoisted(() => ({
  instances: [] as FakeRedisLike[],
}));

interface FakeRedisLike {
  options: unknown;
  connect: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  duplicate: ReturnType<typeof vi.fn>;
}

vi.mock('../src/io.js', () => ({ log: vi.fn() }));

// 用假 ioredis 替身,只关心连接拓扑(主连接 / duplicate 出的阻塞连接),不真正连 Redis。
vi.mock('ioredis', () => {
  class FakeRedis implements FakeRedisLike {
    options: unknown;
    connect = vi.fn(async () => undefined);
    quit = vi.fn(async () => undefined);
    duplicate = vi.fn((): FakeRedis => new FakeRedis(this.options));

    constructor(_url?: unknown, options?: unknown) {
      this.options = options;
      instances.push(this);
    }
  }
  return { Redis: FakeRedis, default: FakeRedis };
});

import {
  connectRedis,
  disconnectRedis,
  getBlockingRedis,
  getRedis,
} from '../src/redis.js';

describe('agent-runtime Redis 连接隔离', () => {
  beforeEach(async () => {
    // 先复位模块级单例(disconnectRedis 对 null 是无操作),保证各用例互不依赖执行顺序。
    await disconnectRedis();
    instances.length = 0;
    vi.clearAllMocks();
    process.env.REDIS_URL = 'redis://localhost:6379';
  });

  // 核心不变量回归:阻塞监听(brpop)必须用与"发流式 token 的主连接"物理隔离的独立连接。
  // 若有人退回到单连接(brpop + publish 共用),并发≥2 时 brpop 会把整轮 token 憋到回合
  // 结束才一次性 flush(表现为对话不流式、服务器憋完一次吐出)。此用例就是为防这次回归而设。
  it('阻塞连接(getBlockingRedis)与主连接(getRedis)是两条不同连接', async () => {
    await connectRedis();

    const main = getRedis();
    const blocking = getBlockingRedis();

    expect(blocking).not.toBe(main);
    // 阻塞连接由主连接 duplicate 而来,保证同配置但独立 socket。
    expect((main as unknown as FakeRedisLike).duplicate).toHaveBeenCalledTimes(1);
    // 两条连接都应已建立。
    expect((main as unknown as FakeRedisLike).connect).toHaveBeenCalledTimes(1);
    expect(
      (blocking as unknown as FakeRedisLike).connect,
    ).toHaveBeenCalledTimes(1);
  });

  it('断开时主连接与阻塞连接都被关闭', async () => {
    await connectRedis();
    const main = getRedis() as unknown as FakeRedisLike;
    const blocking = getBlockingRedis() as unknown as FakeRedisLike;

    await disconnectRedis();

    expect(main.quit).toHaveBeenCalledTimes(1);
    expect(blocking.quit).toHaveBeenCalledTimes(1);
  });

  it('未连接时取连接会抛错', () => {
    expect(() => getRedis()).toThrow();
    expect(() => getBlockingRedis()).toThrow();
  });
});
