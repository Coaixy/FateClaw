import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetOwnedChatSessionMessages, mockListOwnedChatSessionBoards } =
  vi.hoisted(() => ({
    mockGetOwnedChatSessionMessages: vi.fn(),
    mockListOwnedChatSessionBoards: vi.fn(),
  }));

vi.mock('#modules/chat/chat-session-service', () => ({
  archiveOwnedChatSession: vi.fn(),
  createChatSessionForOwnedUser: vi.fn(),
  cancelOwnedChatSessionMessage: vi.fn(),
  getOwnedChatSessionMessages: mockGetOwnedChatSessionMessages,
  getOwnedChatSessionQueryProcessSource: vi.fn(),
  getSharedChatSessionByShareToken: vi.fn(),
  listChatSessionsByClientForOwnedUser: vi.fn(),
  listChatSessionsForOwnedUser: vi.fn(),
  listOwnedChatSessionBoards: mockListOwnedChatSessionBoards,
  renameOwnedChatSession: vi.fn(),
  restoreOwnedArchivedChatSession: vi.fn(),
  shareOwnedChatSessionForUser: vi.fn(),
  sendOwnedChatSessionMessage: vi.fn(),
}));

import { chatSessionsRoutes } from '#interfaces/http/chat-sessions-routes';

describe('chat session routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify({ logger: false });
    await app.register(fastifyJwt, { secret: 'synthetic-route-test-secret' });
    app.decorateRequest('requireAuth', async () => {});
    app.addHook('onRequest', async (request) => {
      request.requireAuth = async () => {
        await request.jwtVerify();
      };
    });
    await app.register(chatSessionsRoutes, { prefix: '/api/chat-sessions' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('forwards both history cursor fields so timestamp ties can continue', async () => {
    mockGetOwnedChatSessionMessages.mockResolvedValueOnce({
      ok: true,
      data: { messages: [], processing: false, processing_request_id: null },
    });
    const query = new URLSearchParams({
      limit: '50',
      before: '2026-10-17T08:00:00.000Z',
      before_id: 'message-050',
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/chat-sessions/s/session-1/messages?${query}`,
      headers: {
        authorization: `Bearer ${app.jwt.sign({ userId: 'user-1' })}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockGetOwnedChatSessionMessages).toHaveBeenCalledWith(
      'user-1',
      'session-1',
      50,
      '2026-10-17T08:00:00.000Z',
      'message-050',
    );
  });

  it('requires authentication before accessing board summaries', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/chat-sessions/s/session-1/boards',
    });

    expect(response.statusCode).toBe(401);
    expect(mockListOwnedChatSessionBoards).not.toHaveBeenCalled();
  });

  it('uses the authenticated user and returns the board list', async () => {
    const boards = [
      {
        source_message_id: 'board-1',
        skill: 'bazi-paipan',
        title: 'Synthetic chart',
      },
    ];
    mockListOwnedChatSessionBoards.mockResolvedValueOnce({
      ok: true,
      data: { boards },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/chat-sessions/s/session-1/boards',
      headers: {
        authorization: `Bearer ${app.jwt.sign({ userId: 'user-1' })}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ boards });
    expect(mockListOwnedChatSessionBoards).toHaveBeenCalledWith(
      'user-1',
      'session-1',
    );
  });

  it('preserves the ownership failure status', async () => {
    mockListOwnedChatSessionBoards.mockResolvedValueOnce({
      ok: false,
      statusCode: 403,
      error: '无权操作',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/chat-sessions/s/session-1/boards',
      headers: {
        authorization: `Bearer ${app.jwt.sign({ userId: 'user-1' })}`,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: '无权操作' });
  });
});
