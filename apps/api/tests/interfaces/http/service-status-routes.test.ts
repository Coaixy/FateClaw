import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock(
  '../../../src/infrastructure/repositories/benefit-repository.js',
  () => ({
    getBenefitSupply: async () => 'disabled',
    getRecentBenefitSuccess: async () => null,
  }),
);
vi.mock(
  '../../../src/infrastructure/repositories/service-status-repository.js',
  () => ({
    listServiceStatusChecks: f.list,
    SERVICE_CHECK_INTERVAL_SECONDS: 21600,
    SERVICE_STATUS_STALE_SECONDS: 43200,
  }),
);
import { serviceStatusRoutes } from '../../../src/interfaces/http/service-status-routes.js';
import { publicServiceStatus } from '../../../src/modules/system/service-status.js';

describe('public service status', () => {
  it('serves shared cached observations without authentication or private node details', async () => {
    f.list.mockResolvedValue([
      {
        checked_at: new Date().toISOString(),
        status: 'operational',
        latency_ms: 120,
        apiKey: 'synthetic-private-value',
        model: 'private-model',
        provider_url: 'https://private.invalid',
      },
    ]);
    const app = Fastify();
    await app.register(serviceStatusRoutes, { prefix: '/api/service-status' });
    try {
      for (let index = 0; index < 3; index += 1) {
        const response = await app.inject({
          method: 'GET',
          url: '/api/service-status',
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toContain('public');
        expect(response.json()).toMatchObject({
          status: 'operational',
          checked_at: expect.any(String),
          latency_ms: 120,
          check_interval_seconds: 21600,
          stale_after_seconds: 43200,
          history: [
            {
              checked_at: expect.any(String),
              status: 'operational',
              latency_ms: 120,
            },
          ],
        });
        expect(response.json().services).toHaveLength(2);
        expect(JSON.stringify(response.json())).not.toContain(
          'synthetic-private-value',
        );
        expect(JSON.stringify(response.json())).not.toContain('private-model');
      }
      expect(
        (await app.inject({ method: 'POST', url: '/api/service-status' }))
          .statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
  it('marks results older than twelve hours as unknown and hides their latency', () => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    const stale = publicServiceStatus(
      [
        {
          checked_at: '2026-10-14T23:59:59Z',
          status: 'operational',
          latency_ms: 10,
        },
      ],
      now,
    );
    expect(stale.status).toBe('unknown');
    expect(stale.latency_ms).toBeNull();
    expect(publicServiceStatus([], now)).toMatchObject({
      status: 'unknown',
      checked_at: null,
      history: [],
    });
  });
});
