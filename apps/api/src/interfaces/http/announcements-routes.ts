import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getAdminAnnouncements,
  getPublicAnnouncements,
  saveAnnouncement,
} from '../../modules/announcements/announcement-service.js';

const statusSchema = z.enum(['draft', 'published', 'archived']);
const writeSchema = z.object({
  title: z.string().trim().min(1, '请输入公告标题').max(120, '标题最多 120 字'),
  body_markdown: z
    .string()
    .trim()
    .min(1, '请输入公告正文')
    .max(20000, '正文最多 20000 字'),
  status: statusSchema,
  expected_revision: z.number().int().min(0).max(2147483646),
});

export async function announcementRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { items: await getPublicAnnouncements() };
  });
}

// Register only inside adminRoutes so its authentication and scope hooks are inherited.
export async function adminAnnouncementRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get('/', async (request, reply) => {
    const parsed = z
      .object({
        page: z.coerce.number().int().min(1).max(100000).default(1),
        status: statusSchema.optional(),
      })
      .safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: '公告筛选参数不正确' });
    }
    reply.header('Cache-Control', 'no-store');
    return getAdminAnnouncements(parsed.data.page, parsed.data.status);
  });

  app.put('/:id', async (request, reply) => {
    const params = z
      .object({ id: z.string().uuid() })
      .safeParse(request.params);
    const body = writeSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: !body.success ? body.error.issues[0]?.message : '公告 ID 不正确',
      });
    }
    const result = await saveAnnouncement(params.data.id, body.data);
    if ('error' in result) {
      return reply.code(result.status).send({ error: result.error });
    }
    return result.announcement;
  });
}
