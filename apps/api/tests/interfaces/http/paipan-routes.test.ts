import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCommitDirectPaipanForOwnedUser,
  mockGetUserById,
  mockListDirectPaipanCatalogForOwnedUser,
  mockPreviewDirectPaipanForOwnedUser,
  mockReverseGanzhiForPaipan,
  mockFixedWindowRateLimit,
} = vi.hoisted(() => ({
  mockCommitDirectPaipanForOwnedUser: vi.fn(),
  mockGetUserById: vi.fn(),
  mockListDirectPaipanCatalogForOwnedUser: vi.fn(),
  mockPreviewDirectPaipanForOwnedUser: vi.fn(),
  mockReverseGanzhiForPaipan: vi.fn(),
  mockFixedWindowRateLimit: vi.fn(),
}));

vi.mock('#interfaces/http/rate-limit', () => ({
  fixedWindowRateLimit: mockFixedWindowRateLimit,
}));

vi.mock('#infrastructure/db', () => ({
  getUserById: mockGetUserById,
}));

vi.mock('#modules/chat/paipan-service', () => ({
  commitDirectPaipanForOwnedUser: mockCommitDirectPaipanForOwnedUser,
  listDirectPaipanCatalogForOwnedUser: mockListDirectPaipanCatalogForOwnedUser,
  previewDirectPaipanForOwnedUser: mockPreviewDirectPaipanForOwnedUser,
}));

vi.mock('#modules/chat/ganzhi-reverse-service', () => ({
  reverseGanzhiForPaipan: mockReverseGanzhiForPaipan,
}));

import { paipanRoutes } from '#interfaces/http/paipan-routes';

describe('paipanRoutes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFixedWindowRateLimit.mockResolvedValue({
      allowed: true,
      retryAfterSec: 0,
    });
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
    mockReverseGanzhiForPaipan.mockReturnValue({
      ok: true,
      data: {
        mode: 'eight_char',
        input: {
          year: '乙巳',
          month: '癸未',
          day: '丁丑',
          hour: '癸卯',
          startYear: 2025,
          endYear: 2025,
          limit: 50,
        },
        matches: [
          {
            solar: '2025-7-7 6:00:00',
            year: 2025,
            month: 7,
            day: 7,
            hour: 6,
            minute: 0,
            second: 0,
          },
        ],
        total: 1,
        truncated: false,
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

  it('stops public computation when the limiter is unavailable', async () => {
    mockFixedWindowRateLimit.mockResolvedValue({
      allowed: false,
      unavailable: true,
      retryAfterSec: 5,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/preview',
      payload: { skill: 'iching', input: {} },
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(mockPreviewDirectPaipanForOwnedUser).not.toHaveBeenCalled();
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

  it('returns ganzhi reverse candidates', async () => {
    const payload = {
      year: '乙巳',
      month: '癸未',
      day: '丁丑',
      hour: '癸卯',
      startYear: 2025,
      endYear: 2025,
    };

    const response = await app.inject({
      method: 'POST',
      url: '/ganzhi-reverse',
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(mockReverseGanzhiForPaipan).toHaveBeenCalledWith(payload);
    expect(response.json()).toMatchObject({
      mode: 'eight_char',
      matches: [{ year: 2025, month: 7, day: 7, hour: 6 }],
    });
  });
});
