import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetActiveAnnouncement,
  mockGetPublicAnnouncementBySlug,
  mockListPublicAnnouncements,
} = vi.hoisted(() => ({
  mockGetActiveAnnouncement: vi.fn(),
  mockGetPublicAnnouncementBySlug: vi.fn(),
  mockListPublicAnnouncements: vi.fn(),
}));

vi.mock('../../../src/infrastructure/db.js', () => ({
  getActiveAnnouncement: mockGetActiveAnnouncement,
  getPublicAnnouncementBySlug: mockGetPublicAnnouncementBySlug,
  listPublicAnnouncements: mockListPublicAnnouncements,
}));

import { publicRoutes } from '../../../src/interfaces/http/public-routes.js';

function announcementFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'announcement-1',
    slug: 'maintenance',
    title: '维护公告',
    summary: '今晚维护',
    body_markdown: '今晚 23:00 维护',
    status: 'published',
    priority: 10,
    starts_at: null,
    ends_at: null,
    cta_label: null,
    cta_href: null,
    published_at: '2026-06-12T00:00:00.000Z',
    created_at: '2026-06-12T00:00:00.000Z',
    updated_at: '2026-06-12T00:00:00.000Z',
    ...overrides,
  };
}

describe('publicRoutes announcements', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetActiveAnnouncement.mockResolvedValue(null);
    mockListPublicAnnouncements.mockResolvedValue([]);
    mockGetPublicAnnouncementBySlug.mockResolvedValue(null);

    app = Fastify({ logger: false });
    await app.register(publicRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the active announcement envelope', async () => {
    mockGetActiveAnnouncement.mockResolvedValueOnce(announcementFixture());

    const response = await app.inject({
      method: 'GET',
      url: '/announcements/active',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      announcement: expect.objectContaining({ slug: 'maintenance' }),
    });
  });

  it('returns the public announcement list', async () => {
    mockListPublicAnnouncements.mockResolvedValueOnce([announcementFixture()]);

    const response = await app.inject({
      method: 'GET',
      url: '/announcements',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      announcements: [expect.objectContaining({ slug: 'maintenance' })],
    });
  });

  it('returns 404 for unpublished or missing announcement details', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/announcements/missing',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: '公告不存在或尚未发布' });
  });
});
