import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const { mockGetUserById, mockLoggerError, mockLoggerWarn } = vi.hoisted(() => ({
  mockGetUserById: vi.fn(),
  mockLoggerError: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('../../../src/infrastructure/config.js', () => ({
  ALLOWED_ORIGINS: ['https://admin.letfate.test'],
  JWT_SECRET: 'test-jwt-secret',
  PUBLIC_WEB_BASE_URL: 'https://www.letfate.test',
}));

vi.mock('../../../src/infrastructure/db.js', () => ({
  getUserById: mockGetUserById,
}));

vi.mock('../../../src/infrastructure/logger.js', () => ({
  logger: {
    error: mockLoggerError,
    info: vi.fn(),
    warn: mockLoggerWarn,
  },
}));

vi.mock('../../../src/infrastructure/project-root.js', () => ({
  resolveProjectRoot: vi.fn(() => '/tmp/fateclaw-api-server-test'),
}));

vi.mock('../../../src/runtime/ai-chat-stream.js', () => ({
  registerAiChatStreamWebSocket: vi.fn(),
}));

vi.mock('../../../src/interfaces/http/account-routes.js', () => ({
  accountRoutes: vi.fn(async () => {}),
}));
vi.mock('../../../src/interfaces/http/admin-routes.js', () => ({
  adminRoutes: vi.fn(async () => {}),
}));
vi.mock('../../../src/interfaces/http/billing-routes.js', () => ({
  billingRoutes: vi.fn(async () => {}),
}));
vi.mock('../../../src/interfaces/http/chat-sessions-routes.js', () => ({
  chatSessionsRoutes: vi.fn(async () => {}),
}));
vi.mock('../../../src/interfaces/http/messages-routes.js', () => ({
  messagesRoutes: vi.fn(async () => {}),
}));
vi.mock('../../../src/interfaces/http/model-settings-routes.js', () => ({
  modelSettingsRoutes: vi.fn(async () => {}),
}));
vi.mock('../../../src/interfaces/http/paipan-routes.js', () => ({
  paipanRoutes: vi.fn(async () => {}),
}));
vi.mock('../../../src/interfaces/http/public-routes.js', () => ({
  publicRoutes: vi.fn(async () => {}),
}));
vi.mock('../../../src/interfaces/http/skills-routes.js', () => ({
  skillsRoutes: vi.fn(async () => {}),
}));

vi.mock('../../../src/interfaces/http/auth-routes.js', () => ({
  authRoutes: vi.fn(async (app: FastifyInstance) => {
    app.get('/protected-test', async (request) => {
      await request.requireAuth();
      return { userId: request.user.userId };
    });
  }),
}));

import { createApiServer } from '../../../src/interfaces/http/server.js';

describe('createApiServer auth guard', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetUserById.mockResolvedValue({
      id: 'user-1',
      auth_token_version: 2,
    });
    app = await createApiServer();
  });

  afterEach(async () => {
    await app.close();
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
