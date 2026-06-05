import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const { mockGetUserById, mockLoggerError, mockLoggerWarn } = vi.hoisted(() => ({
  mockGetUserById: vi.fn(),
  mockLoggerError: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('../../infrastructure/config.js', () => ({
  JWT_SECRET: 'test-jwt-secret',
}));

vi.mock('../../infrastructure/db.js', () => ({
  getUserById: mockGetUserById,
}));

vi.mock('../../infrastructure/logger.js', () => ({
  logger: {
    error: mockLoggerError,
    info: vi.fn(),
    warn: mockLoggerWarn,
  },
}));

vi.mock('../../infrastructure/project-root.js', () => ({
  resolveProjectRoot: vi.fn(() => '/tmp/fateclaw-api-server-test'),
}));

vi.mock('../../runtime/ai-chat-stream.js', () => ({
  registerAiChatStreamWebSocket: vi.fn(),
}));

vi.mock('./account-routes.js', () => ({
  accountRoutes: vi.fn(async () => {}),
}));
vi.mock('./admin-routes.js', () => ({ adminRoutes: vi.fn(async () => {}) }));
vi.mock('./billing-routes.js', () => ({
  billingRoutes: vi.fn(async () => {}),
}));
vi.mock('./chat-sessions-routes.js', () => ({
  chatSessionsRoutes: vi.fn(async () => {}),
}));
vi.mock('./messages-routes.js', () => ({
  messagesRoutes: vi.fn(async () => {}),
}));
vi.mock('./model-settings-routes.js', () => ({
  modelSettingsRoutes: vi.fn(async () => {}),
}));
vi.mock('./paipan-routes.js', () => ({ paipanRoutes: vi.fn(async () => {}) }));
vi.mock('./public-routes.js', () => ({ publicRoutes: vi.fn(async () => {}) }));
vi.mock('./skills-routes.js', () => ({ skillsRoutes: vi.fn(async () => {}) }));

vi.mock('./auth-routes.js', () => ({
  authRoutes: vi.fn(async (app: FastifyInstance) => {
    app.get('/protected-test', async (request) => {
      await request.requireAuth();
      return { userId: request.user.userId };
    });
  }),
}));

import { createApiServer } from './server.js';

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
});
