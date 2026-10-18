import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  list: vi.fn(),
  supply: vi.fn(),
  success: vi.fn(),
  usage: vi.fn(),
  limit: vi.fn(),
}));
vi.mock('#interfaces/http/rate-limit', () => ({
  fixedWindowRateLimit: f.limit,
}));
vi.mock('#infrastructure/repositories/benefit-repository', () => ({
  getBenefitSupply: f.supply,
  getRecentBenefitSuccess: f.success,
}));
vi.mock('#infrastructure/repositories/service-status-repository', () => ({
  listServiceStatusChecks: f.list,
  getServiceTokenUsage: f.usage,
  SERVICE_CHECK_INTERVAL_SECONDS: 21600,
  SERVICE_STATUS_STALE_SECONDS: 43200,
}));
import { serviceStatusRoutes } from '#interfaces/http/service-status-routes';
import { publicServiceStatus } from '#modules/system/service-status';

describe('public service status', () => {
  const apps: FastifyInstance[] = [];
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
    f.list.mockResolvedValue([]);
    f.supply.mockResolvedValue('disabled');
    f.success.mockResolvedValue(null);
    f.usage.mockResolvedValue({
      total_tokens: 1234567,
      today_tokens: 4567,
      updated_at: '2026-10-16T00:00:00.000Z',
      daily: [{ date: '2026-10-16', tokens: 4567 }],
    });
    f.limit.mockResolvedValue({ allowed: true, retryAfterSec: 0 });
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    vi.useRealTimers();
  });
  async function createApp() {
    const app = Fastify();
    apps.push(app);
    await app.register(serviceStatusRoutes, { prefix: '/api/service-status' });
    await app.ready();
    return app;
  }

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
    const app = await createApp();
    for (let index = 0; index < 3; index += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/service-status?refresh=${index}`,
        headers: { authorization: `Bearer synthetic-${index}` },
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
        token_usage: {
          total_tokens: 1234567,
          today_tokens: 4567,
          updated_at: '2026-10-16T00:00:00.000Z',
          daily: [{ date: '2026-10-16', tokens: 4567 }],
        },
      });
      expect(response.json().services).toHaveLength(2);
      expect(JSON.stringify(response.json())).not.toContain(
        'synthetic-private-value',
      );
      expect(JSON.stringify(response.json())).not.toContain('private-model');
    }
    expect(f.list).toHaveBeenCalledTimes(2);
    expect(f.supply).toHaveBeenCalledOnce();
    expect(f.success).toHaveBeenCalledOnce();
    expect(f.usage).toHaveBeenCalledOnce();
    const head = await app.inject({
      method: 'HEAD',
      url: '/api/service-status',
    });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(f.list).toHaveBeenCalledTimes(2);
    expect(f.limit).toHaveBeenCalledTimes(4);
    expect(
      (await app.inject({ method: 'POST', url: '/api/service-status' }))
        .statusCode,
    ).toBe(404);
  });

  it('coalesces concurrent reads and expires the snapshot without renewing its observation time', async () => {
    let release!: (history: []) => void;
    let started!: () => void;
    const pending = new Promise<[]>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.list.mockImplementation(() => {
      if (f.list.mock.calls.length === 2) started();
      return pending;
    });
    const app = await createApp();
    const requests = Array.from({ length: 20 }, () =>
      app.inject('/api/service-status').then((response) => response),
    );
    await reading;
    expect(f.list).toHaveBeenCalledTimes(2);
    release([]);
    const responses = await Promise.all(requests);
    expect(responses.every((response) => response.statusCode === 200)).toBe(
      true,
    );
    expect(f.list).toHaveBeenCalledTimes(2);
    const observedAt = responses[0].json().services[1].supply_checked_at;

    vi.setSystemTime(new Date('2026-10-16T00:00:30Z'));
    const cached = await app.inject('/api/service-status');
    expect(cached.json().services[1].supply_checked_at).toBe(observedAt);
    expect(cached.headers['cache-control']).toContain('max-age=30');
    expect(f.list).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date('2026-10-16T00:01:00Z'));
    await Promise.all(
      Array.from({ length: 20 }, () => app.inject('/api/service-status')),
    );
    expect(f.list).toHaveBeenCalledTimes(4);
    expect(f.supply).toHaveBeenCalledTimes(2);
    expect(f.usage).toHaveBeenCalledTimes(2);
    const refreshed = await app.inject('/api/service-status');
    expect(refreshed.json().services[1].supply_checked_at).toBe(
      '2026-10-16T00:01:00.000Z',
    );
  });

  it('does not cache read failures or serve an expired snapshot as fresh', async () => {
    const app = await createApp();
    await app.inject('/api/service-status');
    vi.setSystemTime(new Date('2026-10-16T00:01:00Z'));
    f.list.mockRejectedValueOnce(new Error('Synthetic database failure'));
    const failed = await app.inject('/api/service-status');
    expect(failed.statusCode).toBe(500);
    expect(failed.headers['cache-control']).toBe('no-store');
    const recovered = await app.inject('/api/service-status');
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().services[1].supply_checked_at).toBe(
      '2026-10-16T00:01:00.000Z',
    );
    expect(f.list).toHaveBeenCalledTimes(6);
  });

  it.each([
    { unavailable: false, status: 429 },
    { unavailable: true, status: 503 },
  ])(
    'refuses reads before querying when the limiter returns $status',
    async ({ unavailable, status }) => {
      const app = await createApp();
      await app.inject('/api/service-status');
      f.list.mockClear();
      f.supply.mockClear();
      f.success.mockClear();
      f.usage.mockClear();
      f.limit.mockResolvedValue({
        allowed: false,
        retryAfterSec: 17,
        unavailable,
      });
      const response = await app.inject({
        url: '/api/service-status',
        remoteAddress: '203.0.113.8',
      });
      expect(response.statusCode).toBe(status);
      expect(response.headers['retry-after']).toBe('17');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(f.limit).toHaveBeenLastCalledWith(
        'service-status:203.0.113.8',
        60,
        60,
      );
      expect(f.list).not.toHaveBeenCalled();
      expect(f.supply).not.toHaveBeenCalled();
      expect(f.success).not.toHaveBeenCalled();
      expect(f.usage).not.toHaveBeenCalled();
    },
  );
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
