import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const {
  mockGetUserById,
  mockLoggerError,
  mockLoggerWarn,
  mockPublicStatus,
  mockStatusLimit,
  mockProjectRoot,
} = vi.hoisted(() => ({
  mockGetUserById: vi.fn(),
  mockLoggerError: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockPublicStatus: vi.fn(),
  mockStatusLimit: vi.fn(),
  mockProjectRoot: vi.fn(() => '/tmp/fateclaw-api-server-test'),
}));

vi.mock('#modules/system/service-status', () => ({
  getPublicServiceStatus: mockPublicStatus,
}));
vi.mock('#interfaces/http/rate-limit', () => ({
  fixedWindowRateLimit: mockStatusLimit,
}));

vi.mock('#infrastructure/config', () => ({
  ALLOWED_ORIGINS: ['https://admin.letfate.test'],
  JWT_SECRET: 'test-jwt-secret',
  PUBLIC_WEB_BASE_URL: 'https://www.letfate.test',
  TRUST_PROXY: 'loopback',
}));

vi.mock('#infrastructure/db', () => ({
  getUserById: mockGetUserById,
}));

vi.mock('#infrastructure/logger', () => ({
  logger: {
    error: mockLoggerError,
    info: vi.fn(),
    warn: mockLoggerWarn,
  },
}));

vi.mock('#infrastructure/project-root', () => ({
  resolveProjectRoot: mockProjectRoot,
}));

vi.mock('#runtime/ai-chat-stream', () => ({
  registerAiChatStreamWebSocket: vi.fn(),
}));

vi.mock('#interfaces/http/account-routes', () => ({
  accountRoutes: vi.fn(async () => {}),
}));
vi.mock('#interfaces/http/admin-routes', () => ({
  adminRoutes: vi.fn(async () => {}),
}));
vi.mock('#interfaces/http/billing-routes', () => ({
  billingRoutes: vi.fn(async () => {}),
}));
vi.mock('#interfaces/http/chat-sessions-routes', () => ({
  chatSessionsRoutes: vi.fn(async () => {}),
}));
vi.mock('#interfaces/http/messages-routes', () => ({
  messagesRoutes: vi.fn(async () => {}),
}));
vi.mock('#interfaces/http/model-settings-routes', () => ({
  modelSettingsRoutes: vi.fn(async () => {}),
}));
vi.mock('#interfaces/http/paipan-routes', () => ({
  paipanRoutes: vi.fn(async () => {}),
}));
vi.mock('#interfaces/http/skills-routes', () => ({
  skillsRoutes: vi.fn(async () => {}),
}));

vi.mock('#interfaces/http/auth-routes', () => ({
  authRoutes: vi.fn(async (app: FastifyInstance) => {
    app.get('/protected-test', async (request) => {
      await request.requireAuth();
      return { userId: request.user.userId };
    });
  }),
}));

import { createApiServer } from '#interfaces/http/server';

describe('createApiServer auth guard', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetUserById.mockResolvedValue({
      id: 'user-1',
      auth_token_version: 2,
    });
    mockPublicStatus.mockResolvedValue({ status: 'unknown', history: [] });
    mockStatusLimit.mockResolvedValue({ allowed: true, retryAfterSec: 0 });
    app = await createApiServer();
  });

  afterEach(async () => {
    await app.close();
  });

  it('preserves document, immutable asset, and font headers when serving real static files', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'fateclaw-server-static-'),
    );
    const files = [
      'index.html',
      '_next/static/chunks/app.js',
      '_next/static/media/font.woff2',
    ];
    try {
      for (const file of files) {
        const filename = path.join(root, 'apps/web/out', file);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, 'static fixture');
      }
      mockProjectRoot.mockReturnValue(root);
      await app.close();
      app = await createApiServer();

      const document = await app.inject('/index.html');
      expect(document.statusCode).toBe(200);
      expect(document.headers['cache-control']).toContain('no-store');
      expect(document.headers['cdn-cache-control']).toBe('no-store');
      expect(document.headers['surrogate-control']).toBe('no-store');

      const chunk = await app.inject('/_next/static/chunks/app.js');
      expect(chunk.statusCode).toBe(200);
      expect(chunk.headers['cache-control']).toBe(
        'public, max-age=31536000, immutable',
      );

      const font = await app.inject({
        url: '/_next/static/media/font.woff2',
        headers: { 'sec-fetch-site': 'same-origin' },
      });
      expect(font.statusCode).toBe(200);
      expect(font.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(font.headers.vary).toContain('Sec-Fetch-Site');
    } finally {
      mockProjectRoot.mockReturnValue('/tmp/fateclaw-api-server-test');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('serves public status with coherent cache headers while protected APIs remain private', async () => {
    const response = await app.inject('/api/service-status');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('public, max-age=');
    for (const header of [
      'cdn-cache-control',
      'surrogate-control',
      'pragma',
      'expires',
    ]) {
      expect(response.headers[header]).toBeUndefined();
    }
    const vary = String(response.headers.vary).toLowerCase();
    expect(vary).toContain('origin');
    expect(vary).not.toContain('authorization');
    expect(vary).not.toContain('cookie');

    const protectedResponse = await app.inject('/api/auth/protected-test');
    expect(protectedResponse.statusCode).toBe(401);
    expect(protectedResponse.headers['cache-control']).toContain('no-store');
    expect(protectedResponse.headers['cdn-cache-control']).toBe('no-store');
  });

  it('keeps failed public status reads uncacheable through the global error handler', async () => {
    mockPublicStatus.mockRejectedValueOnce(
      new Error('Synthetic database failure'),
    );
    const response = await app.inject('/api/service-status');
    expect(response.statusCode).toBe(500);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['cdn-cache-control']).toBe('no-store');
    expect(response.headers['surrogate-control']).toBe('no-store');
  });

  it('excludes issue search text from request error logs', async () => {
    await app.inject({ url: '/api/issues?q=synthetic-private-search' });
    const logs = JSON.stringify(mockLoggerWarn.mock.calls);
    expect(logs).toContain('/api/issues');
    expect(logs).not.toContain('synthetic-private-search');
  });

  it('returns JSON 404 for retired case dataset endpoints', async () => {
    expect(app.hasRoute({ method: 'GET', url: '/api/bazi-cases' })).toBe(false);

    for (const url of [
      '/api/bazi-cases',
      '/api/bazi-cases/',
      '/api/bazi-cases/overview',
      '/api/bazi-cases/1',
    ]) {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.json()).toMatchObject({ error: 'Not Found' });
    }
  });

  it.each([
    '/api/public/announcements',
    '/api/public/announcements/active',
    '/api/public/announcements/retired-announcement',
  ])('returns JSON 404 for the retired public endpoint %s', async (url) => {
    expect(
      app.hasRoute({ method: 'GET', url: '/api/public/announcements/:slug' }),
    ).toBe(false);

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toMatchObject({ error: 'Not Found' });
  });

  it('does not log stream ticket query credentials on failed upgrades', async () => {
    await app.inject({
      method: 'GET',
      url: '/api/chat-sessions/s/session-1/stream?ticket=synthetic-test-ticket',
    });
    expect(mockLoggerWarn).toHaveBeenCalled();
    expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain(
      'synthetic-test-ticket',
    );
  });

  it.each([
    '/login',
    '/login/',
    '/login/index.html',
    '/api/auth/invites/preview',
    '/api/admin/registration-invites',
  ])(
    'excludes invitation query credentials from error logs for %s',
    async (pathname) => {
      await app.inject({
        url: `${pathname}?invite=synthetic-registration-invite`,
      });
      const logs = JSON.stringify([
        ...mockLoggerWarn.mock.calls,
        ...mockLoggerError.mock.calls,
      ]);
      expect(logs).toContain(pathname);
      expect(logs).not.toContain('synthetic-registration-invite');
    },
  );

  it('does not log invitation fragments from malformed JSON parser errors', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/invites/preview',
      headers: { 'content-type': 'application/json' },
      payload: '{ "inviteCode":!"0123456789ABCDEF01234567" }',
    });
    expect(response.statusCode).toBe(400);
    const logs = JSON.stringify([
      ...mockLoggerWarn.mock.calls,
      ...mockLoggerError.mock.calls,
    ]);
    expect(logs).not.toContain('01234567');
  });

  it('returns a readable JSON error for oversized bodies and retains the default limit outside Skill writes', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/invites/preview',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: '请求内容过大，请减少内容后重试',
    });
  });

  it('accepts a token whose auth version matches the current user', async () => {
    const token = app.jwt.sign({
      userId: 'user-1',
      authTokenVersion: 2,
    } as { userId: string });

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/protected-test',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ userId: 'user-1' });
  });

  it('rejects an old token after the user auth version changes', async () => {
    const token = app.jwt.sign({
      userId: 'user-1',
      authTokenVersion: 1,
    } as { userId: string });

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/protected-test',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects legacy tokens without an auth version', async () => {
    const token = app.jwt.sign({ userId: 'user-1' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/protected-test',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('allows public web origin on CORS preflight requests', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/chat-sessions/s/session-test',
      headers: {
        origin: 'https://www.letfate.test',
        'access-control-request-method': 'DELETE',
        'access-control-request-headers': 'authorization',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(
      'https://www.letfate.test',
    );
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-methods']).toContain(
      'DELETE',
    );
  });
});
