import type { FastifyInstance } from 'fastify';
import type { ServiceStatusOverviewDto } from '@fateclaw/contracts/service-status';
import { getPublicServiceStatus } from '../../modules/system/service-status.js';
import { fixedWindowRateLimit } from './rate-limit.js';

const STATUS_CACHE_TTL_MS = 60_000;

interface StatusSnapshot {
  value: ServiceStatusOverviewDto;
  expiresAt: number;
}

export async function serviceStatusRoutes(app: FastifyInstance): Promise<void> {
  let cached: StatusSnapshot | undefined;
  let refreshing: Promise<StatusSnapshot> | undefined;

  async function readSnapshot(): Promise<StatusSnapshot> {
    if (cached && cached.expiresAt > Date.now()) return cached;
    // A public snapshot has one owner even when many callers miss the cache together.
    if (!refreshing) {
      refreshing = getPublicServiceStatus()
        .then((value) => {
          cached = { value, expiresAt: Date.now() + STATUS_CACHE_TTL_MS };
          return cached;
        })
        .finally(() => {
          refreshing = undefined;
        });
    }
    return refreshing;
  }

  app.get(
    '/',
    {
      onRequest: async (request, reply) => {
        const limit = await fixedWindowRateLimit(
          `service-status:${request.ip}`,
          60,
          60,
        );
        if (!limit.allowed) {
          return reply
            .header('Retry-After', String(limit.retryAfterSec))
            .code(limit.unavailable ? 503 : 429)
            .send({
              error: limit.unavailable
                ? '限流服务暂时不可用，请稍后重试'
                : '请求过于频繁，请稍后再试',
            });
        }
      },
      onSend: async (_request, reply, payload) => {
        if (reply.statusCode !== 200) {
          reply.header('Cache-Control', 'no-store');
          reply.header('CDN-Cache-Control', 'no-store');
          reply.header('Surrogate-Control', 'no-store');
        }
        return payload;
      },
    },
    async (_request, reply) => {
      const snapshot = await readSnapshot();
      const remainingSeconds = Math.max(
        0,
        Math.floor((snapshot.expiresAt - Date.now()) / 1000),
      );
      reply.header(
        'Cache-Control',
        `public, max-age=${remainingSeconds}, stale-while-revalidate=60`,
      );
      for (const header of [
        'CDN-Cache-Control',
        'Surrogate-Control',
        'Pragma',
        'Expires',
      ]) {
        reply.removeHeader(header);
      }
      const vary = String(reply.getHeader('Vary') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value && !/^(authorization|cookie)$/i.test(value));
      if (vary.length) reply.header('Vary', vary.join(', '));
      else reply.removeHeader('Vary');
      return snapshot.value;
    },
  );
}
