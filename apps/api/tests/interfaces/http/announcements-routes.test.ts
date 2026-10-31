import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  getPublicAnnouncements: vi.fn(),
  getAdminAnnouncements: vi.fn(),
  saveAnnouncement: vi.fn(),
  castAnnouncementVote: vi.fn(),
}));
vi.mock('#modules/announcements/announcement-service', () => service);

import {
  adminAnnouncementRoutes,
  announcementRoutes,
} from '#interfaces/http/announcements-routes';
import { AnnouncementError } from '#modules/announcements/announcement-error';

describe('announcement HTTP contracts', () => {
  let app: FastifyInstance;
  const id = 'fbd24536-1376-4a5e-a5e3-d4c735f0123a';
  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    app.decorateRequest('requireAuth', async function () {
      if (this.headers.authorization !== 'Bearer synthetic-user-a') {
        throw Object.assign(new Error('请先登录'), { statusCode: 401 });
      }
      this.user = { userId: 'voter-a', authTokenVersion: 1 };
    });
    await app.register(announcementRoutes, { prefix: '/api/announcements' });
    await app.register(adminAnnouncementRoutes, {
      prefix: '/api/admin/announcements',
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it('serves public notices without login and prevents stale browser caching', async () => {
    service.getPublicAnnouncements.mockResolvedValue([{ id, title: '通知' }]);
    const response = await app.inject({ url: '/api/announcements' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [{ id, title: '通知' }] });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each([
    {
      title: ' ',
      body_markdown: '正文',
      status: 'published',
      expected_revision: 0,
    },
    {
      title: '标题',
      body_markdown: ' ',
      status: 'published',
      expected_revision: 0,
    },
    {
      title: '标题',
      body_markdown: '正文',
      status: 'unknown',
      expected_revision: 0,
    },
    {
      title: '标题',
      body_markdown: '正文',
      status: 'draft',
      expected_revision: -1,
    },
    {
      title: 'a'.repeat(121),
      body_markdown: '正文',
      status: 'draft',
      expected_revision: 0,
    },
  ])('rejects invalid writes before persistence', async (payload) => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/admin/announcements/${id}`,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(service.saveAnnouncement).not.toHaveBeenCalled();
  });

  it('normalizes content and returns a concurrency conflict for a stale edit', async () => {
    service.saveAnnouncement.mockResolvedValue({
      status: 409,
      error: '请刷新',
    });
    const response = await app.inject({
      method: 'PUT',
      url: `/api/admin/announcements/${id}`,
      payload: {
        title: ' 标题 ',
        body_markdown: ' 正文 ',
        status: 'published',
        expected_revision: 3,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(service.saveAnnouncement).toHaveBeenCalledWith(id, {
      title: '标题',
      body_markdown: '正文',
      status: 'published',
      expected_revision: 3,
    });
  });

  const optionId = '962fd573-c202-4dd1-8ca5-ef23bde1c167';
  const poll = {
    question: '优先更新什么？',
    options: [
      { id: optionId, label: '体验' },
      { id: 'bdd253a5-a823-4fb5-8324-2aef3203e822', label: '功能' },
    ],
    is_closed: false,
    closes_at: null,
  };

  it('accepts a complete multi-choice selection for the verified account', async () => {
    const optionIds = poll.options.map((option) => option.id);
    service.castAnnouncementVote.mockResolvedValue({
      ...poll,
      allow_multiple: true,
      total_votes: 1,
      selected_option_ids: optionIds,
    });
    const response = await app.inject({
      method: 'PUT',
      url: `/api/announcements/${id}/vote`,
      headers: { authorization: 'Bearer synthetic-user-a' },
      payload: { option_ids: optionIds, expected_revision: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(service.castAnnouncementVote).toHaveBeenCalledWith(
      id,
      'voter-a',
      optionIds,
      1,
    );
    expect(response.json().selected_option_ids).toEqual(optionIds);
  });

  it.each([false, true])(
    'persists the configured multiple-choice mode: %s',
    async (allowMultiple) => {
      service.saveAnnouncement.mockResolvedValue({ announcement: { id } });
      const payload = {
        title: '更新计划',
        body_markdown: '请投票',
        status: 'published',
        expected_revision: 0,
        poll: { ...poll, allow_multiple: allowMultiple },
      };
      const response = await app.inject({
        method: 'PUT',
        url: `/api/admin/announcements/${id}`,
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(service.saveAnnouncement).toHaveBeenCalledWith(id, payload);
    },
  );

  it.each([
    [],
    [optionId, optionId],
    [optionId, optionId.toUpperCase()],
    Array.from(
      { length: 11 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    ),
    ['invalid-id'],
  ])(
    'rejects empty, repeated, excessive or invalid selections before persistence',
    async (optionIds) => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/announcements/${id}/vote`,
        headers: { authorization: 'Bearer synthetic-user-a' },
        payload: { option_ids: optionIds, expected_revision: 1 },
      });
      expect(response.statusCode).toBe(400);
      expect(service.castAnnouncementVote).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...poll, options: poll.options.slice(0, 1) },
    { ...poll, options: [poll.options[0], poll.options[0]] },
    {
      ...poll,
      options: poll.options.map((option) => ({ ...option, label: ' 同名 ' })),
    },
    { ...poll, question: ' ' },
    { ...poll, closes_at: 'not-a-date' },
  ])(
    'rejects invalid poll configurations before persistence',
    async (value) => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/admin/announcements/${id}`,
        payload: {
          title: '更新',
          body_markdown: '正文',
          status: 'published',
          expected_revision: 0,
          poll: value,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(service.saveAnnouncement).not.toHaveBeenCalled();
    },
  );

  it('uses the verified account for personalized reads and voting', async () => {
    service.getPublicAnnouncements.mockResolvedValue([]);
    await app.inject({
      url: '/api/announcements',
      headers: { authorization: 'Bearer synthetic-user-a' },
    });
    expect(service.getPublicAnnouncements).toHaveBeenCalledWith('voter-a');
    service.castAnnouncementVote.mockResolvedValue({
      ...poll,
      total_votes: 1,
      selected_option_ids: [optionId],
    });
    const response = await app.inject({
      method: 'PUT',
      url: `/api/announcements/${id}/vote`,
      headers: { authorization: 'Bearer synthetic-user-a' },
      payload: { option_ids: [optionId], expected_revision: 3 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.vary).toContain('Authorization');
    expect(service.castAnnouncementVote).toHaveBeenCalledWith(
      id,
      'voter-a',
      [optionId],
      3,
    );
  });

  it('requires login and rejects identity overrides and missing revision before voting', async () => {
    const request = {
      method: 'PUT' as const,
      url: `/api/announcements/${id}/vote`,
      payload: { option_ids: [optionId], expected_revision: 1 },
    };
    expect((await app.inject(request)).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          ...request,
          headers: { authorization: 'Bearer synthetic-user-a' },
          payload: { ...request.payload, user_id: 'voter-b' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          ...request,
          headers: { authorization: 'Bearer synthetic-user-a' },
          payload: { option_ids: [optionId] },
        })
      ).statusCode,
    ).toBe(400);
    expect(service.castAnnouncementVote).not.toHaveBeenCalled();
  });

  it('returns actionable vote conflicts without exposing database errors', async () => {
    service.castAnnouncementVote.mockRejectedValue(
      new AnnouncementError(409, '投票已结束，无法提交或修改'),
    );
    const response = await app.inject({
      method: 'PUT',
      url: `/api/announcements/${id}/vote`,
      headers: { authorization: 'Bearer synthetic-user-a' },
      payload: { option_ids: [optionId], expected_revision: 1 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: '投票已结束，无法提交或修改' });
  });
});
