import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ISSUE_KINDS,
  ISSUE_LABELS,
  ISSUE_CLOSE_REASONS,
} from '@fateclaw/contracts';
import { fixedWindowRateLimit } from './rate-limit.js';
import { IssueError } from '#modules/issues/issue-errors';
import {
  getAdminIssue,
  getPublicIssue,
  listAdminIssues,
  listPublicIssues,
} from '#modules/issues/issue-service';
import {
  editIssue,
  editIssueComment,
  insertIssue,
  insertIssueComment,
  moderateIssue,
  moderateIssueComment,
  moderateIssueParticipant,
} from '#infrastructure/repositories/issues-repository';

const idSchema = z.coerce.number().int().positive().max(2147483647);
const paramsSchema = z.object({ id: idSchema });
const commentParamsSchema = z.object({ id: idSchema, entryId: idSchema });
const listSchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    state: z.enum(['open', 'closed']).optional(),
    kind: z.enum(ISSUE_KINDS).optional(),
    label: z.enum(ISSUE_LABELS).optional(),
    mine: z.enum(['true']).optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    page_size: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
const cursorSchema = z
  .object({ before: z.coerce.number().int().min(0).max(2147483647).default(0) })
  .strict();
const contentSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(10000),
  })
  .strict();
const createSchema = contentSchema.extend({
  kind: z.enum(ISSUE_KINDS),
  request_key: z.uuid(),
});
const commentSchema = z
  .object({ body: z.string().trim().min(1).max(2000), request_key: z.uuid() })
  .strict();
const moderationSchema = z
  .object({
    state: z.enum(['open', 'closed']).optional(),
    close_reason: z.enum(ISSUE_CLOSE_REASONS).nullable().optional(),
    labels: z
      .array(z.enum(ISSUE_LABELS))
      .max(4)
      .transform((labels) => [...new Set(labels)])
      .optional(),
    locked: z.boolean().optional(),
    hidden: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

function issueErrors(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof IssueError) {
      if (error.retryAfterSec) reply.header('Retry-After', error.retryAfterSec);
      return reply.code(error.statusCode).send({ error: error.message });
    }
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: '请求参数无效，请检查内容长度和选项' });
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    // User content and database error details must not enter public responses or logs.
    if (status >= 500) request.log.error('Issue request failed');
    return reply.code(status).send({
      error:
        status === 413
          ? '提交内容过大'
          : status === 401
            ? '请先登录'
            : status >= 500
              ? '服务暂时不可用，请稍后重试'
              : '请求参数无效',
    });
  });
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
}

async function enforceLimit(key: string, limit: number, seconds: number) {
  const result = await fixedWindowRateLimit(key, limit, seconds);
  if (!result.allowed)
    throw new IssueError(
      result.unavailable ? 503 : 429,
      result.unavailable
        ? '限流服务暂时不可用，请稍后重试'
        : '请求过于频繁，请稍后再试',
      result.retryAfterSec,
    );
}

export async function issuesRoutes(app: FastifyInstance) {
  issueErrors(app);
  app.addHook('onRequest', async (request) => {
    const ip = createHash('sha256').update(request.ip).digest('hex');
    await enforceLimit(`issues:ip:${ip}`, 120, 60);
    const readOnly = request.method === 'GET' || request.method === 'HEAD';
    if (!readOnly || request.headers.authorization) await request.requireAuth();
    if (!readOnly) {
      await enforceLimit(`issues:write:ip:${ip}`, 30, 60);
      await enforceLimit(`issues:write:user:${request.user.userId}`, 20, 60);
    }
  });

  app.get('/', async (request) => {
    const filter = listSchema.parse(request.query);
    if (filter.mine && !request.headers.authorization)
      throw new IssueError(401, '请先登录');
    return listPublicIssues(
      { ...filter, mine: filter.mine ? request.user.userId : undefined },
      request.headers.authorization ? request.user.userId : undefined,
    );
  });
  app.get('/:id', async (request) => {
    const { id } = paramsSchema.parse(request.params);
    const { before } = cursorSchema.parse(request.query);
    return getPublicIssue(
      id,
      before,
      request.headers.authorization ? request.user.userId : undefined,
    );
  });
  app.post('/', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const result = await insertIssue(
      request.user.userId,
      createSchema.parse(request.body),
    );
    return reply.code(201).send(result);
  });
  app.patch('/:id', { bodyLimit: 64 * 1024 }, async (request) => {
    const { id } = paramsSchema.parse(request.params);
    const body = contentSchema.parse(request.body);
    await editIssue(id, request.user.userId, body.title, body.body);
    return { success: true };
  });
  app.post(
    '/:id/comments',
    { bodyLimit: 16 * 1024 },
    async (request, reply) => {
      const { id } = paramsSchema.parse(request.params);
      const body = commentSchema.parse(request.body);
      return reply
        .code(201)
        .send(
          await insertIssueComment(
            id,
            { kind: 'user', userId: request.user.userId },
            body.body,
            body.request_key,
          ),
        );
    },
  );
  app.patch(
    '/:id/comments/:entryId',
    { bodyLimit: 16 * 1024 },
    async (request) => {
      const { id, entryId } = commentParamsSchema.parse(request.params);
      const { body } = commentSchema
        .omit({ request_key: true })
        .parse(request.body);
      await editIssueComment(id, entryId, request.user.userId, body);
      return { success: true };
    },
  );
}

export async function adminIssueRoutes(app: FastifyInstance) {
  issueErrors(app);
  app.addHook('onRequest', async (request) => {
    if (request.adminPrincipal?.role !== 'owner')
      throw new IssueError(403, '无权访问该管理功能');
    await enforceLimit(
      `issues:admin:${createHash('sha256').update(request.ip).digest('hex')}`,
      120,
      60,
    );
  });
  app.get('/', async (request) => {
    const filter = listSchema.omit({ mine: true }).parse(request.query);
    return listAdminIssues(filter);
  });
  app.get('/:id', async (request) => {
    const { id } = paramsSchema.parse(request.params);
    return getAdminIssue(id, cursorSchema.parse(request.query).before);
  });
  app.patch('/:id', { bodyLimit: 8 * 1024 }, async (request) => {
    await moderateIssue(
      paramsSchema.parse(request.params).id,
      moderationSchema.parse(request.body),
    );
    return { success: true };
  });
  app.post(
    '/:id/comments',
    { bodyLimit: 16 * 1024 },
    async (request, reply) => {
      const { body, request_key } = commentSchema.parse(request.body);
      return reply
        .code(201)
        .send(
          await insertIssueComment(
            paramsSchema.parse(request.params).id,
            { kind: 'official' },
            body,
            request_key,
          ),
        );
    },
  );
  app.patch('/:id/comments/:entryId', { bodyLimit: 1024 }, async (request) => {
    const { id, entryId } = commentParamsSchema.parse(request.params);
    await moderateIssueComment(
      id,
      entryId,
      z.object({ hidden: z.boolean() }).strict().parse(request.body).hidden,
    );
    return { success: true };
  });
  app.patch(
    '/:id/participants/:participant',
    { bodyLimit: 1024 },
    async (request) => {
      const { id, participant } = z
        .object({
          id: idSchema,
          participant: z.coerce.number().int().min(0).max(2147483647),
        })
        .parse(request.params);
      await moderateIssueParticipant(
        id,
        participant,
        z.object({ muted: z.boolean() }).strict().parse(request.body).muted,
      );
      return { success: true };
    },
  );
}
