import { FastifyInstance } from 'fastify';

import {
  getActiveAnnouncement,
  getPublicAnnouncementBySlug,
  listPublicAnnouncements,
} from '../../infrastructure/db.js';

/**
 * 注册无需登录的公开接口。
 *
 * 公开页面不依赖登录态，所有接口都必须只返回可公开展示的数据。
 */
export async function publicRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/public/announcements/active — 当前顶部横幅公告
  app.get('/announcements/active', async () => {
    return { announcement: await getActiveAnnouncement() };
  });

  // GET /api/public/announcements — 公开公告列表
  app.get('/announcements', async () => {
    return { announcements: await listPublicAnnouncements() };
  });

  // GET /api/public/announcements/:slug — 公开公告详情
  app.get<{ Params: { slug: string } }>(
    '/announcements/:slug',
    async (request, reply) => {
      const announcement = await getPublicAnnouncementBySlug(
        request.params.slug,
      );
      if (!announcement) {
        return reply.code(404).send({ error: '公告不存在或尚未发布' });
      }
      return { announcement };
    },
  );
}
