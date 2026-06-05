import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCommitDirectPaipanForOwnedUser,
  mockGetUserById,
  mockListDirectPaipanCatalogForOwnedUser,
  mockPreviewDirectPaipanForOwnedUser,
} = vi.hoisted(() => ({
  mockCommitDirectPaipanForOwnedUser: vi.fn(),
  mockGetUserById: vi.fn(),
  mockListDirectPaipanCatalogForOwnedUser: vi.fn(),
  mockPreviewDirectPaipanForOwnedUser: vi.fn(),
}));

vi.mock('../../infrastructure/db.js', () => ({
  getUserById: mockGetUserById,
}));

vi.mock('../../modules/chat/paipan-service.js', () => ({
  commitDirectPaipanForOwnedUser: mockCommitDirectPaipanForOwnedUser,
  listDirectPaipanCatalogForOwnedUser: mockListDirectPaipanCatalogForOwnedUser,
  previewDirectPaipanForOwnedUser: mockPreviewDirectPaipanForOwnedUser,
}));

import { paipanRoutes } from './paipan-routes.js';

describe('paipanRoutes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockListDirectPaipanCatalogForOwnedUser.mockResolvedValue({
      ok: true,
      data: [],
    });
    mockGetUserById.mockResolvedValue({
      id: 'user-1',
      auth_token_version: 2,
    });
    mockPreviewDirectPaipanForOwnedUser.mockResolvedValue({
      ok: true,
      data: {
        previewId: 'preview-1',
        skillContextEntry: {
          skill: 'iching-paipan',
          output: 'ok',
          artifactType: 'skill.iching-paipan',
          artifactTitle: '六爻排盘',
          artifactData: { ok: true },
        },
        expiresAt: '2026-05-09T00:30:00.000Z',
      },
    });

    app = Fastify({ logger: false });
    await app.register(fastifyJwt, { secret: 'test-secret' });
    app.decorateRequest('requireAuth', async () => {});
    app.addHook('onRequest', async (request) => {
      request.requireAuth = async () => {
        await request.jwtVerify();
      };
    });
    await app.register(paipanRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('passes authenticated user id to preview service', async () => {
    const token = app.jwt.sign({ userId: 'user-1', authTokenVersion: 2 });

    const response = await app.inject({
      method: 'POST',
      url: '/preview',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        skill: 'iching-paipan',
        input: { topic: '测试' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockPreviewDirectPaipanForOwnedUser).toHaveBeenCalledWith({
      userId: 'user-1',
      skill: 'iching-paipan',
      input: { topic: '测试' },
    });
  });

  it('keeps preview public when there is no valid login token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/preview',
      headers: {
        authorization: 'Bearer invalid-token',
      },
      payload: {
        skill: 'iching-paipan',
        input: { topic: '测试' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockPreviewDirectPaipanForOwnedUser).toHaveBeenCalledWith({
      userId: undefined,
      skill: 'iching-paipan',
      input: { topic: '测试' },
    });
  });
});
