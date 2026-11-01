import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_MEMORY_CONTENT_CHARS } from '@fateclaw/contracts/memory';

const { service, jobs, logger } = vi.hoisted(() => ({
  service: {
    clearMemory: vi.fn(),
    createManualMemory: vi.fn(),
    excludeMemorySource: vi.fn(),
    forgetManualMemory: vi.fn(),
    getMemoryEvidence: vi.fn(),
    getMemorySettings: vi.fn(),
    listMemory: vi.fn(),
    memoryStatus: vi.fn(),
    updateManualMemory: vi.fn(),
    updateMemorySettings: vi.fn(),
  },
  jobs: {
    startMemoryBackfill: vi.fn(),
    changeMemoryJobState: vi.fn(),
    retryMemoryJob: vi.fn(),
  },
  logger: { error: vi.fn() },
}));
vi.mock('#modules/memory/service', () => service);
vi.mock('#modules/memory/jobs', () => jobs);
vi.mock('#infrastructure/logger', () => ({ logger }));

import { memoryRoutes } from '#interfaces/http/memory-routes';
import { MemoryError } from '#modules/memory/domain';

const headers = { authorization: 'Bearer synthetic-memory-user' };
const owner = 'synthetic-memory-owner';
const from = '2026-10-01T00:00:00.000Z';
const to = '2026-10-31T23:59:59.999Z';

describe('memory HTTP routes', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.resetAllMocks();
    app = Fastify({ logger: false });
    app.decorateRequest('requireAuth', async function () {
      if (this.headers.authorization !== headers.authorization)
        throw Object.assign(new Error('请先登录'), { statusCode: 401 });
      this.user = { userId: owner, authTokenVersion: 1 };
    });
    await app.register(memoryRoutes, { prefix: '/api/memory' });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  const requests = [
    { method: 'GET', url: '/api/memory' },
    { method: 'GET', url: '/api/memory/settings' },
    { method: 'PATCH', url: '/api/memory/settings' },
    { method: 'POST', url: '/api/memory' },
    { method: 'PATCH', url: '/api/memory/item' },
    { method: 'GET', url: '/api/memory/item/evidence' },
    { method: 'DELETE', url: '/api/memory/item?revision=1' },
    { method: 'POST', url: '/api/memory/clear' },
    { method: 'GET', url: '/api/memory/status' },
    { method: 'POST', url: '/api/memory/backfill' },
    { method: 'POST', url: '/api/memory/jobs/job/pause' },
    { method: 'POST', url: '/api/memory/jobs/job/resume' },
    { method: 'POST', url: '/api/memory/sources/source/exclude' },
  ] as const;
  it.each(requests)(
    'authenticates before $method $url can reach memory services',
    async (request) => {
      expect((await app.inject(request)).statusCode).toBe(401);
      for (const method of [...Object.values(service), ...Object.values(jobs)])
        expect(method).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      method: 'GET',
      url: '/api/memory?q=keyword&subject_id=client%3Asynthetic&status=all&kind=event&cursor=synthetic-cursor&limit=20',
      action: 'listMemory',
      args: [
        owner,
        {
          q: 'keyword',
          subjectId: 'client:synthetic',
          status: 'all',
          kind: 'event',
          cursor: 'synthetic-cursor',
          limit: 20,
        },
      ],
    },
    {
      method: 'GET',
      url: '/api/memory/settings',
      action: 'getMemorySettings',
      args: [owner],
    },
    {
      method: 'PATCH',
      url: '/api/memory/settings',
      payload: {
        revision: 2,
        recall_enabled: false,
        learning_enabled: true,
        chat_editing_enabled: false,
      },
      action: 'updateMemorySettings',
      args: [
        owner,
        {
          revision: 2,
          recall_enabled: false,
          learning_enabled: true,
          chat_editing_enabled: false,
        },
      ],
    },
    {
      method: 'POST',
      url: '/api/memory',
      payload: {
        content: ' Synthetic manual memory ',
        kind: 'preference',
        subject_id: 'self:synthetic',
      },
      action: 'createManualMemory',
      args: [
        owner,
        {
          content: 'Synthetic manual memory',
          kind: 'preference',
          subject_id: 'self:synthetic',
        },
      ],
    },
    {
      method: 'PATCH',
      url: '/api/memory/item',
      payload: { content: 'Synthetic correction', revision: 3 },
      action: 'updateManualMemory',
      args: [owner, 'item', { content: 'Synthetic correction', revision: 3 }],
    },
    {
      method: 'GET',
      url: '/api/memory/item/evidence',
      action: 'getMemoryEvidence',
      args: [owner, 'item'],
    },
    {
      method: 'POST',
      url: '/api/memory/clear',
      action: 'clearMemory',
      args: [owner, false],
    },
    {
      method: 'POST',
      url: '/api/memory/clear',
      payload: { reset_context: true },
      action: 'clearMemory',
      args: [owner, true],
    },
    {
      method: 'GET',
      url: '/api/memory/status',
      action: 'memoryStatus',
      args: [owner],
    },
  ] as const)(
    'binds $action to the authenticated owner and preserves its response',
    async ({ action, args, ...request }) => {
      const result = { synthetic_result: action };
      service[action].mockResolvedValueOnce(result);
      const response = await app.inject({ ...request, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(result);
      expect(service[action]).toHaveBeenCalledWith(...args);
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );

  it('uses ownership-bound job operations and returns acknowledgement only after exclusion and forgetting', async () => {
    const job = { id: 'synthetic-job', state: 'pending' };
    jobs.startMemoryBackfill.mockResolvedValue(job);
    jobs.changeMemoryJobState.mockResolvedValue({ ...job, state: 'paused' });
    const backfill = {
      session_ids: ['synthetic-session'],
      client_id: 'synthetic-client',
      from,
      to,
    };
    const response = await app.inject({
      method: 'POST',
      url: '/api/memory/backfill',
      payload: backfill,
      headers,
    });
    expect(response.json()).toEqual(job);
    expect(jobs.startMemoryBackfill).toHaveBeenCalledWith(owner, backfill);
    for (const action of ['pause', 'resume'] as const) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/memory/jobs/synthetic-job/${action}`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect(jobs.changeMemoryJobState).toHaveBeenCalledWith(
        owner,
        'synthetic-job',
        action,
      );
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/memory/sources/synthetic-source/exclude',
          headers,
        })
      ).json(),
    ).toEqual({ success: true });
    expect(service.excludeMemorySource).toHaveBeenCalledWith(
      owner,
      'synthetic-source',
    );
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/memory/item?revision=4',
          headers,
        })
      ).json(),
    ).toEqual({ success: true });
    expect(service.forgetManualMemory).toHaveBeenCalledWith(owner, 'item', 4);
  });

  it.each([
    { method: 'GET', url: '/api/memory?owner_user_id=another-owner' },
    { method: 'GET', url: '/api/memory?limit=101' },
    { method: 'GET', url: '/api/memory?status=unknown' },
    { method: 'GET', url: '/api/memory?kind=unknown' },
    {
      method: 'POST',
      url: '/api/memory',
      payload: { content: 'Synthetic', owner_user_id: 'another-owner' },
    },
    {
      method: 'POST',
      url: '/api/memory',
      payload: { content: 'x'.repeat(MAX_MEMORY_CONTENT_CHARS + 1) },
    },
    {
      method: 'PATCH',
      url: '/api/memory/item',
      payload: { content: 'Synthetic', revision: 0 },
    },
    {
      method: 'PATCH',
      url: '/api/memory/settings',
      payload: { revision: 1, recall_enabled: 'false' },
    },
    { method: 'PATCH', url: '/api/memory/settings', payload: { revision: 1 } },
    { method: 'DELETE', url: '/api/memory/item' },
    { method: 'DELETE', url: '/api/memory/item?revision=1.5' },
    {
      method: 'POST',
      url: '/api/memory/clear',
      payload: { include_soul: true },
    },
    {
      method: 'POST',
      url: '/api/memory/clear',
      payload: 'null',
      headers: { 'content-type': 'application/json' },
    },
    {
      method: 'POST',
      url: '/api/memory/backfill',
      payload: 'null',
      headers: { 'content-type': 'application/json' },
    },
    {
      method: 'POST',
      url: '/api/memory/backfill',
      payload: { session_ids: ['x'.repeat(201)] },
    },
    {
      method: 'POST',
      url: '/api/memory/backfill',
      payload: { from: 'invalid-date' },
    },
    {
      method: 'POST',
      url: '/api/memory/backfill',
      payload: { from: to, to: from },
    },
    {
      method: 'POST',
      url: '/api/memory/backfill',
      payload: { session_ids: ['duplicate', 'duplicate'] },
    },
    {
      method: 'POST',
      url: '/api/memory/jobs/job/pause',
      payload: { owner_user_id: 'another-owner' },
    },
  ] as const)(
    'rejects invalid or identity-changing $method $url before persistence',
    async (request) => {
      expect(
        (
          await app.inject({
            ...request,
            headers: {
              ...headers,
              ...('headers' in request ? request.headers : {}),
            },
          })
        ).statusCode,
      ).toBe(400);
      for (const action of [...Object.values(service), ...Object.values(jobs)])
        expect(action).not.toHaveBeenCalled();
    },
  );

  it('preserves domain conflicts and hides unexpected database diagnostics from errors and logs', async () => {
    service.updateManualMemory.mockRejectedValueOnce(
      new MemoryError('记忆版本已变化', 409, 'MEMORY.CONFLICT'),
    );
    const conflict = await app.inject({
      method: 'PATCH',
      url: '/api/memory/item',
      payload: { content: 'Synthetic update', revision: 1 },
      headers,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: '记忆版本已变化',
      code: 'MEMORY.CONFLICT',
    });
    service.listMemory.mockRejectedValueOnce(
      new Error('SYNTHETIC_PRIVATE_DATABASE_BODY'),
    );
    const unavailable = await app.inject({
      method: 'GET',
      url: '/api/memory',
      headers,
    });
    expect(unavailable.statusCode).toBe(500);
    expect(unavailable.json().code).toBe('MEMORY.UNAVAILABLE');
    expect(unavailable.body).not.toContain('SYNTHETIC_PRIVATE_DATABASE_BODY');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      'SYNTHETIC_PRIVATE_DATABASE_BODY',
    );
  });
});
