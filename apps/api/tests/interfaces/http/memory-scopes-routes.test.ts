import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  update: vi.fn(),
  items: vi.fn(),
  backfill: vi.fn(),
}));
vi.mock('#modules/memory/scope-management', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('#modules/memory/scope-management')
  >()),
  listMemoryScopes: mocks.list,
  updateMemoryScopeBinding: mocks.update,
}));
vi.mock('#modules/memory/service', () => ({ listMemory: mocks.items }));
vi.mock('#modules/memory/jobs', () => ({
  startMemoryBackfill: mocks.backfill,
}));
vi.mock('#infrastructure/logger', () => ({ logger: { error: vi.fn() } }));

import { memoryRoutes } from '#interfaces/http/memory-routes';
import { MemoryError } from '#modules/memory/domain';

const headers = { authorization: 'Bearer synthetic-scope-owner' };
const binding = {
  speaker_subject_id: 'client:synthetic-client',
  share_subject_memory: false,
  revision: 1,
};

describe('memory scope HTTP routes', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.resetAllMocks();
    app = Fastify({ logger: false });
    app.decorateRequest('requireAuth', async function () {
      if (this.headers.authorization !== headers.authorization)
        throw Object.assign(new Error('请先登录'), { statusCode: 401 });
      this.user = { userId: 'synthetic-owner', authTokenVersion: 1 };
    });
    await app.register(memoryRoutes, { prefix: '/api/memory' });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it.each([
    { method: 'GET', url: '/api/memory/scopes' },
    {
      method: 'PATCH',
      url: '/api/memory/scopes/scope/binding',
      payload: binding,
    },
  ] as const)(
    'authenticates $method $url before accessing scope metadata',
    async (request) => {
      expect((await app.inject(request)).statusCode).toBe(401);
      expect(mocks.list).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it('lists owned scope metadata and forwards a validated binding with the logged-in owner', async () => {
    const result = {
      scopes: [
        { id: 'scope', channel: 'wechat', display_name: '微信联系人 1' },
      ],
      subjects: [
        { id: 'self:synthetic-owner', kind: 'self', name: '用户本人' },
      ],
    };
    mocks.list.mockResolvedValueOnce(result);
    const listed = await app.inject({ url: '/api/memory/scopes', headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual(result);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(mocks.list).toHaveBeenCalledWith('synthetic-owner');
    const saved = {
      id: 'scope',
      channel: 'wechat',
      display_name: '合成联系人',
      speaker_subject_id: binding.speaker_subject_id,
      share_subject_memory: false,
      binding_revision: 2,
    };
    mocks.update.mockResolvedValueOnce(saved);
    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/memory/scopes/scope/binding',
      headers,
      payload: { ...binding, display_name: ' 合成联系人 ' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual(saved);
    expect(mocks.update).toHaveBeenCalledWith('synthetic-owner', 'scope', {
      ...binding,
      display_name: '合成联系人',
    });
  });

  it.each([
    { ...binding, revision: 0 },
    { ...binding, share_subject_memory: 'false' },
    { ...binding, owner_user_id: 'other-owner' },
    { ...binding, display_name: ' ' },
    { ...binding, speaker_subject_id: '' },
    { ...binding, display_name: 'x'.repeat(121) },
  ])('rejects invalid binding fields before mutation: %j', async (payload) => {
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/memory/scopes/scope/binding',
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('returns binding conflicts without translating them into a successful update', async () => {
    mocks.update.mockRejectedValueOnce(
      new MemoryError(
        '说话人绑定已被更新，请刷新后重试',
        409,
        'MEMORY.BINDING_CONFLICT',
      ),
    );
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/memory/scopes/scope/binding',
      headers,
      payload: binding,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('MEMORY.BINDING_CONFLICT');
  });

  it('forwards explicit scope filters and backfill scope selections without changing ownership', async () => {
    mocks.items.mockResolvedValueOnce({
      items: [],
      subjects: [],
      next_cursor: null,
    });
    const filtered = await app.inject({
      url: '/api/memory?scope_id=synthetic-scope',
      headers,
    });
    expect(filtered.statusCode).toBe(200);
    expect(mocks.items).toHaveBeenCalledWith(
      'synthetic-owner',
      expect.objectContaining({ scopeId: 'synthetic-scope' }),
    );
    mocks.backfill.mockResolvedValueOnce({
      id: 'synthetic-job',
      state: 'pending',
    });
    const backfill = await app.inject({
      method: 'POST',
      url: '/api/memory/backfill',
      headers,
      payload: { scope_ids: ['synthetic-scope'] },
    });
    expect(backfill.statusCode).toBe(200);
    expect(mocks.backfill).toHaveBeenCalledWith('synthetic-owner', {
      scope_ids: ['synthetic-scope'],
    });
    for (const scope_ids of [[], ['duplicate', 'duplicate'], ['x'.repeat(201)]])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/memory/backfill',
            headers,
            payload: { scope_ids },
          })
        ).statusCode,
      ).toBe(400);
    expect(mocks.backfill).toHaveBeenCalledOnce();
  });
});
