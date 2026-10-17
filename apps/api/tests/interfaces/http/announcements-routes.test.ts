import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  getPublicAnnouncements: vi.fn(),
  getAdminAnnouncements: vi.fn(),
  saveAnnouncement: vi.fn(),
}));
vi.mock(
  '../../../src/modules/announcements/announcement-service.js',
  () => service,
);

import {
  adminAnnouncementRoutes,
  announcementRoutes,
} from '../../../src/interfaces/http/announcements-routes.js';

describe('announcement HTTP contracts', () => {
  let app: FastifyInstance;
  const id = 'fbd24536-1376-4a5e-a5e3-d4c735f0123a';
  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
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
});
