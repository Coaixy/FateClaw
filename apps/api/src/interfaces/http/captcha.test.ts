import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRedis } = vi.hoisted(() => {
  type Entry = { value: string; expiresAt: number | null };
  const store = new Map<string, Entry>();

  const redis = {
    store,
    async del(...keys: string[]) {
      let deleted = 0;
      for (const key of keys) {
        if (store.delete(key)) deleted += 1;
      }
      return deleted;
    },
    async expire(key: string, ttlSeconds: number) {
      const entry = store.get(key);
      if (!entry) return 0;
      entry.expiresAt = Date.now() + ttlSeconds * 1000;
      return 1;
    },
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async incr(key: string) {
      const entry = store.get(key);
      const nextValue = Number(entry?.value ?? '0') + 1;
      store.set(key, {
        value: String(nextValue),
        expiresAt: entry?.expiresAt ?? null,
      });
      return nextValue;
    },
    async set(
      key: string,
      value: string,
      exFlag?: 'EX',
      ttlSeconds?: number,
      nxFlag?: 'NX',
    ) {
      if (nxFlag === 'NX' && store.has(key)) return null;
      store.set(key, {
        value,
        expiresAt:
          exFlag === 'EX' ? Date.now() + (ttlSeconds ?? 0) * 1000 : null,
      });
      return 'OK';
    },
  };

  return { mockRedis: redis };
});

vi.mock('../../infrastructure/config.js', () => ({
  JWT_SECRET: 'test-jwt-secret',
}));

vi.mock('../../infrastructure/redis.js', () => ({
  getRedis: vi.fn(() => mockRedis),
}));

import { generateCaptcha, verifyCaptcha } from './captcha.js';

const CLIENT_IP = '203.0.113.7';

function extractCaptchaText(svg: string): string {
  return [...svg.matchAll(/<text\b[^>]*>([^<])<\/text>/g)]
    .map((match) => match[1])
    .join('');
}

describe('captcha', () => {
  beforeEach(() => {
    mockRedis.store.clear();
  });

  it('stores answer material in Redis instead of exposing it in the token', async () => {
    const challenge = await generateCaptcha(CLIENT_IP);
    const [challengeId] = challenge.token.split('.');

    expect(challengeId).toMatch(/^[0-9a-f]{32}$/);
    expect(challenge.token).not.toContain('"h"');
    expect(challenge.token).not.toContain('"n"');

    const state = JSON.parse(
      mockRedis.store.get(`captcha:challenge:${challengeId}`)?.value ?? '{}',
    ) as Record<string, unknown>;
    expect(state.h).toEqual(expect.any(String));
    expect(state.n).toEqual(expect.any(String));
    expect(
      mockRedis.store.get(`captcha:challenge:${challengeId}:attempts`)?.value,
    ).toBe('0');
  });

  it('counts wrong answers and rejects attempts after the limit', async () => {
    const challenge = await generateCaptcha(CLIENT_IP);

    await expect(
      verifyCaptcha(challenge.token, 'wrong-1', CLIENT_IP),
    ).resolves.toEqual({ ok: false, reason: 'wrong_answer' });
    await expect(
      verifyCaptcha(challenge.token, 'wrong-2', CLIENT_IP),
    ).resolves.toEqual({ ok: false, reason: 'wrong_answer' });
    await expect(
      verifyCaptcha(challenge.token, 'wrong-3', CLIENT_IP),
    ).resolves.toEqual({ ok: false, reason: 'wrong_answer' });
    await expect(
      verifyCaptcha(
        challenge.token,
        extractCaptchaText(challenge.svg),
        CLIENT_IP,
      ),
    ).resolves.toEqual({ ok: false, reason: 'too_many_attempts' });
  });

  it('accepts the right answer once and rejects replay', async () => {
    const challenge = await generateCaptcha(CLIENT_IP);
    const answer = extractCaptchaText(challenge.svg);

    await expect(
      verifyCaptcha(challenge.token, answer, CLIENT_IP),
    ).resolves.toEqual({
      ok: true,
    });
    await expect(
      verifyCaptcha(challenge.token, answer, CLIENT_IP),
    ).resolves.toEqual({
      ok: false,
      reason: 'expired_or_consumed',
    });
  });
});
