import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockStartSimpleWorkflowForOwnedUser } = vi.hoisted(() => ({
  mockStartSimpleWorkflowForOwnedUser: vi.fn(),
}));

vi.mock('../../../src/modules/chat/simple-workflow-service.js', () => ({
  startSimpleWorkflowForOwnedUser: mockStartSimpleWorkflowForOwnedUser,
}));

import { simpleWorkflowsRoutes } from '../../../src/interfaces/http/simple-workflows-routes.js';

describe('simpleWorkflowsRoutes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockStartSimpleWorkflowForOwnedUser.mockResolvedValue({
      ok: true,
      data: {
        session: {
          id: 'session-1',
          account_id: 'web:user-1',
          title: '占卜问事',
          created_at: '2026-06-09T00:00:00.000Z',
          updated_at: '2026-06-09T00:00:00.000Z',
          deleted_at: null,
        },
        boardMessageId: 'board-1',
        requestId: 'req-1',
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
    await app.register(simpleWorkflowsRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires login before starting a workflow', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/start',
      payload: { kind: 'divination', question: '看看工作' },
    });

    expect(response.statusCode).toBe(401);
    expect(mockStartSimpleWorkflowForOwnedUser).not.toHaveBeenCalled();
  });

  it('starts a divination workflow for the authenticated user', async () => {
    const token = app.jwt.sign({ userId: 'user-1' });

    const response = await app.inject({
      method: 'POST',
      url: '/start',
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: 'divination', question: '看看工作' },
    });

    expect(response.statusCode).toBe(200);
    expect(mockStartSimpleWorkflowForOwnedUser).toHaveBeenCalledWith('user-1', {
      kind: 'divination',
      question: '看看工作',
    });
    expect(response.json()).toMatchObject({
      session: { id: 'session-1' },
      boardMessageId: 'board-1',
      requestId: 'req-1',
    });
  });

  it('rejects unknown simple workflow kinds', async () => {
    const token = app.jwt.sign({ userId: 'user-1' });

    const response = await app.inject({
      method: 'POST',
      url: '/start',
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: 'unknown', question: '看看工作' },
    });

    expect(response.statusCode).toBe(400);
    expect(mockStartSimpleWorkflowForOwnedUser).not.toHaveBeenCalled();
  });
});
