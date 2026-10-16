import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API_KEY_LIVE_PREFIX } from '@fateclaw/contracts/api-keys';

const f = vi.hoisted(() => ({ limit: vi.fn(), entitlement: vi.fn() }));
vi.mock('../../../src/infrastructure/db.js', () => ({
  findActiveApiKeyByHash: vi.fn(async () => ({
    id: 'synthetic-key',
    user_id: 'synthetic-user',
    name: 'Synthetic',
    expires_at: null,
  })),
  hashApiKey: vi.fn(() => 'synthetic-hash'),
  touchApiKeyLastUsed: vi.fn(),
}));
vi.mock('../../../src/infrastructure/redis.js', () => ({
  getRedis: () => ({ set: vi.fn(async () => null) }),
}));
vi.mock('../../../src/modules/billing/entitlements.js', () => ({
  getRuntimeEntitlementSnapshot: f.entitlement,
}));
vi.mock('../../../src/interfaces/http/rate-limit.js', () => ({
  fixedWindowRateLimit: f.limit,
}));
import { apiKeyAuthOnRequest } from '../../../src/interfaces/http/api-key-auth.js';

describe('external API limiter failure boundary', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([
    [
      { allowed: false, unavailable: true, retryAfterSec: 5 },
      503,
      'api_error',
      'service_unavailable',
    ],
    [
      { allowed: false, retryAfterSec: 10 },
      429,
      'rate_limit_exceeded',
      'rate_limit_exceeded',
    ],
  ] as const)(
    'preserves the external error contract without invoking billing',
    async (limit, status, type, code) => {
      f.limit.mockResolvedValue(limit);
      const app = Fastify();
      app.addHook('onRequest', apiKeyAuthOnRequest);
      app.get('/', async () => ({ success: true }));
      try {
        const response = await app.inject({
          url: '/',
          headers: { authorization: `Bearer ${API_KEY_LIVE_PREFIX}synthetic` },
        });
        expect(response.statusCode).toBe(status);
        expect(response.headers['retry-after']).toBe(
          String(limit.retryAfterSec),
        );
        expect(response.json().error).toMatchObject({
          type,
          code,
          param: null,
        });
        expect(f.entitlement).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
});
