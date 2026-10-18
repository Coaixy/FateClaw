import { beforeEach, describe, expect, it, vi } from 'vitest';

const redis = vi.hoisted(() => ({
  eval: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
}));
vi.mock('#infrastructure/redis', () => ({
  getRedis: () => redis,
}));
import { fixedWindowRateLimit } from '#interfaces/http/rate-limit';

describe('fixed-window rate limiting', () => {
  beforeEach(() => vi.resetAllMocks());

  it('refuses requests when Redis is unavailable', async () => {
    redis.eval.mockRejectedValue(new Error('synthetic outage'));
    redis.incr.mockRejectedValue(new Error('synthetic outage'));
    expect(await fixedWindowRateLimit('test:outage', 2, 60)).toMatchObject({
      allowed: false,
      unavailable: true,
    });
  });

  it('counts and expires the window in one atomic operation', async () => {
    redis.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(3);
    redis.incr.mockResolvedValue(1);
    expect((await fixedWindowRateLimit('test:atomic', 2, 60)).allowed).toBe(
      true,
    );
    const denied = await fixedWindowRateLimit('test:atomic', 2, 60);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(redis.incr).not.toHaveBeenCalled();
    expect(redis.expire).not.toHaveBeenCalled();
  });
});
