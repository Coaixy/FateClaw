import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const services = vi.hoisted(() => ({
  sessions: vi.fn(),
  updateSession: vi.fn(),
}));
vi.mock('#modules/memory/session-settings', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('#modules/memory/session-settings')
  >()),
  listMemorySessions: services.sessions,
  updateMemorySessionSettings: services.updateSession,
}));
vi.mock('#infrastructure/env', () => ({ readEnvFile: () => ({}) }));
import { memoryRoutes } from '#interfaces/http/memory-routes';

describe('private memory management routes', () => {
  let app: FastifyInstance;
  const headers = { authorization: 'Bearer synthetic-owner' };
  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify({ logger: false });
    app.decorateRequest('requireAuth', async function () {
      if (this.headers.authorization !== headers.authorization)
        throw Object.assign(new Error('请先登录'), { statusCode: 401 });
      this.user = { userId: 'owner', authTokenVersion: 1 };
    });
    await app.register(memoryRoutes, { prefix: '/api/memory' });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it.each([
    { method: 'GET' as const, url: '/api/memory/sessions' },
    { method: 'PATCH' as const, url: '/api/memory/sessions/session' },
  ])(
    'uses the existing authentication hook before $method $url',
    async (request) => {
      expect((await app.inject(request)).statusCode).toBe(401);
      for (const service of Object.values(services))
        expect(service).not.toHaveBeenCalled();
    },
  );

  it('binds each management endpoint to the authenticated owner and parses its public fields', async () => {
    services.sessions.mockResolvedValue({ sessions: [], next_cursor: null });
    services.updateSession.mockResolvedValue({
      id: 'session',
      title: '备考安排',
      learning_enabled: false,
      revision: 2,
    });
    expect(
      (
        await app.inject({
          url: '/api/memory/sessions?cursor=opaque&limit=200',
          headers,
        })
      ).json(),
    ).toEqual({ sessions: [], next_cursor: null });
    expect(services.sessions).toHaveBeenCalledWith('owner', {
      cursor: 'opaque',
      limit: 200,
    });
    const changed = await app.inject({
      method: 'PATCH',
      url: '/api/memory/sessions/session',
      headers,
      payload: { learning_enabled: false, revision: 1 },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      learning_enabled: false,
      revision: 2,
    });
    expect(services.updateSession).toHaveBeenCalledWith('owner', 'session', {
      learning_enabled: false,
      revision: 1,
    });
    expect(changed.headers['cache-control']).toBe('no-store');
  });

  it.each([
    { method: 'GET' as const, url: '/api/memory/sessions?owner_user_id=other' },
    { method: 'GET' as const, url: '/api/memory/sessions?limit=201' },
    {
      method: 'PATCH' as const,
      url: '/api/memory/sessions/session',
      payload: { learning_enabled: false, revision: 1, owner_user_id: 'other' },
    },
    {
      method: 'PATCH' as const,
      url: '/api/memory/sessions/session',
      payload: { learning_enabled: 'false', revision: 1 },
    },
    {
      method: 'PATCH' as const,
      url: '/api/memory/sessions/session',
      payload: { learning_enabled: false, revision: 0 },
    },
  ])(
    'rejects unsupported management parameters for $method $url',
    async (request) => {
      expect((await app.inject({ ...request, headers })).statusCode).toBe(400);
      for (const service of Object.values(services))
        expect(service).not.toHaveBeenCalled();
    },
  );
});
