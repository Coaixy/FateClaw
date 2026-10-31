import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getAdminAnnouncements,
  getPublicAnnouncements,
  castAnnouncementVote,
  saveAnnouncement,
} from '#modules/announcements/announcement-service';
import { AnnouncementError } from '#modules/announcements/announcement-error';

const statusSchema = z.enum(['draft', 'published', 'archived']);
const uuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const paramsSchema = z.object({ id: uuidSchema });
const pollSchema = z
  .object({
    question: z
      .string()
      .trim()
      .min(1, '请输入投票问题')
      .max(200, '投票问题最多 200 字'),
    allow_multiple: z.boolean().default(false),
    options: z
      .array(
        z
          .object({
            id: uuidSchema,
            label: z
              .string()
              .trim()
              .min(1, '请输入选项内容')
              .max(120, '每个选项最多 120 字'),
          })
          .strict(),
      )
      .min(2, '至少设置 2 个投票选项')
      .max(10, '最多设置 10 个投票选项')
      .refine(
        (options) =>
          new Set(options.map((option) => option.id)).size === options.length &&
          new Set(options.map((option) => option.label)).size ===
            options.length,
        '投票选项不能重复',
      ),
    closes_at: z.string().datetime({ offset: true }).nullable(),
    is_closed: z.boolean(),
  })
  .strict();
const writeSchema = z.object({
  title: z.string().trim().min(1, '请输入公告标题').max(120, '标题最多 120 字'),
  body_markdown: z
    .string()
    .trim()
    .min(1, '请输入公告正文')
    .max(20000, '正文最多 20000 字'),
  status: statusSchema,
  expected_revision: z.number().int().min(0).max(2147483646),
  poll: pollSchema.nullable().optional(),
});

export async function announcementRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Vary', 'Origin, Authorization, Cookie');
    if (
      (request.method !== 'GET' && request.method !== 'HEAD') ||
      request.headers.authorization
    ) {
      await request.requireAuth();
    }
  });
  app.get('/', async (request) => {
    return {
      items: await getPublicAnnouncements(
        request.headers.authorization ? request.user.userId : undefined,
      ),
    };
  });
  app.put('/:id/vote', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = z
      .object({
        option_ids: z
          .array(uuidSchema)
          .min(1)
          .max(10)
          .refine(
            (ids) => new Set(ids).size === ids.length,
            '投票选项不能重复',
          ),
        expected_revision: z.number().int().min(1).max(2147483647),
      })
      .strict()
      .safeParse(request.body);
    if (!params.success || !body.success) {
      return reply
        .code(400)
        .send({ error: '投票参数不正确，请刷新公告后重试' });
    }
    try {
      return await castAnnouncementVote(
        params.data.id,
        request.user.userId,
        body.data.option_ids,
        body.data.expected_revision,
      );
    } catch (error) {
      if (error instanceof AnnouncementError)
        return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
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
    const params = paramsSchema.safeParse(request.params);
    const body = writeSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: !body.success ? body.error.issues[0]?.message : '公告 ID 不正确',
      });
    }
    let result;
    try {
      result = await saveAnnouncement(params.data.id, body.data);
    } catch (error) {
      if (error instanceof AnnouncementError)
        return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
    if ('error' in result) {
      return reply.code(result.status).send({ error: result.error });
    }
    return result.announcement;
  });
}
