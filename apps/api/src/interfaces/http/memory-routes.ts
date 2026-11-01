import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MAX_MEMORY_CONTENT_CHARS,
  MAX_MEMORY_QUERY_CHARS,
} from '@fateclaw/contracts/memory';

import { logger } from '#infrastructure/logger';
import { MemoryError } from '#modules/memory/domain';
import {
  clearMemory,
  createManualMemory,
  excludeMemorySource,
  forgetManualMemory,
  getMemoryEvidence,
  getMemorySettings,
  listMemory,
  memoryStatus,
  updateManualMemory,
  updateMemorySettings,
} from '#modules/memory/service';
import {
  changeMemoryJobState,
  startMemoryBackfill,
} from '#modules/memory/jobs';
import {
  listMemoryScopes,
  memoryScopeBindingSchema,
  updateMemoryScopeBinding,
} from '#modules/memory/scope-management';
import {
  listMemorySessions,
  memorySessionSettingsSchema,
  updateMemorySessionSettings,
} from '#modules/memory/session-settings';

const empty = z.strictObject({});
const identifier = z.string().trim().min(1).max(256);
const params = z.strictObject({ id: identifier });
const revision = z.number().int().positive().max(2_147_483_647);
const queryInteger = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(revision);
const kind = z.enum(['fact', 'preference', 'event', 'plan', 'decision']);
const content = z.string().trim().min(1).max(MAX_MEMORY_CONTENT_CHARS);
const filters = z.strictObject({
  q: z.string().trim().max(MAX_MEMORY_QUERY_CHARS).optional(),
  subject_id: identifier.optional(),
  scope_id: identifier.optional(),
  status: z
    .enum(['active', 'superseded', 'disputed', 'forgotten', 'all'])
    .optional(),
  kind: kind.optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: queryInteger.pipe(z.number().max(100)).optional(),
});
const settings = z
  .strictObject({
    revision,
    learning_enabled: z.boolean().optional(),
    recall_enabled: z.boolean().optional(),
    chat_editing_enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 1);
const date = z.string().max(64).datetime({ offset: true });
const backfill = z
  .strictObject({
    session_ids: z
      .array(identifier.max(200))
      .min(1)
      .max(1000)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    scope_ids: z
      .array(identifier.max(200))
      .min(1)
      .max(1000)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    client_id: identifier.max(200).optional(),
    from: date.optional(),
    to: date.optional(),
  })
  .refine(
    (value) =>
      !value.from ||
      !value.to ||
      Date.parse(value.from) <= Date.parse(value.to),
  );

/** Keep user content and database diagnostics out of HTTP errors and logs. */
export function registerMemoryHttpErrors(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof MemoryError)
      return reply
        .code(error.statusCode)
        .send({ error: error.message, code: error.code });
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: '记忆请求参数不正确，请检查内容长度、选项和版本',
        code: 'MEMORY.INVALID',
      });
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 401) return reply.code(401).send({ error: '请先登录' });
    if (status === 403)
      return reply.code(403).send({ error: '无权访问此记忆功能' });
    if (status === 413)
      return reply
        .code(413)
        .send({ error: '提交内容过大', code: 'MEMORY.INVALID' });
    if (status === 400)
      return reply
        .code(400)
        .send({ error: '记忆请求格式不正确', code: 'MEMORY.INVALID' });
    logger.error(
      {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url,
        errorType: error instanceof Error ? error.name : 'unknown',
      },
      'Memory HTTP operation failed',
    );
    return reply.code(500).send({
      error: '记忆服务暂时不可用，请稍后重试',
      code: 'MEMORY.UNAVAILABLE',
    });
  });
}

export async function memoryRoutes(app: FastifyInstance): Promise<void> {
  registerMemoryHttpErrors(app);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Vary', 'Authorization, Cookie');
    await request.requireAuth();
  });
  app.get('/', async (request) => {
    const query = filters.parse(request.query);
    return listMemory(request.user.userId, {
      q: query.q,
      subjectId: query.subject_id,
      ...(query.scope_id ? { scopeId: query.scope_id } : {}),
      status: query.status,
      kind: query.kind,
      cursor: query.cursor,
      limit: query.limit,
    });
  });
  app.get('/settings', async (request) => {
    empty.parse(request.query);
    return getMemorySettings(request.user.userId);
  });
  app.get('/scopes', async (request) => {
    empty.parse(request.query);
    return listMemoryScopes(request.user.userId);
  });
  app.get('/sessions', async (request) => {
    const query = z
      .strictObject({
        cursor: z.string().min(1).max(2048).optional(),
        limit: queryInteger.pipe(z.number().max(200)).optional(),
      })
      .parse(request.query);
    return listMemorySessions(request.user.userId, query);
  });
  app.patch('/sessions/:id', async (request) => {
    empty.parse(request.query);
    return updateMemorySessionSettings(
      request.user.userId,
      params.parse(request.params).id,
      memorySessionSettingsSchema.parse(request.body),
    );
  });
  app.patch('/scopes/:id/binding', async (request) => {
    empty.parse(request.query);
    return updateMemoryScopeBinding(
      request.user.userId,
      params.parse(request.params).id,
      memoryScopeBindingSchema.parse(request.body),
    );
  });
  app.patch('/settings', async (request) => {
    empty.parse(request.query);
    return updateMemorySettings(
      request.user.userId,
      settings.parse(request.body),
    );
  });
  app.post('/', async (request) => {
    empty.parse(request.query);
    const input = z
      .strictObject({
        content,
        kind: kind.optional(),
        subject_id: identifier.optional(),
      })
      .parse(request.body);
    return createManualMemory(request.user.userId, input);
  });
  app.patch('/:id', async (request) => {
    empty.parse(request.query);
    const { id } = params.parse(request.params);
    return updateManualMemory(
      request.user.userId,
      id,
      z.strictObject({ content, revision }).parse(request.body),
    );
  });
  app.get('/:id/evidence', async (request) => {
    empty.parse(request.query);
    return getMemoryEvidence(
      request.user.userId,
      params.parse(request.params).id,
    );
  });
  app.delete('/:id', async (request) => {
    const { revision } = z
      .strictObject({ revision: queryInteger })
      .parse(request.query);
    await forgetManualMemory(
      request.user.userId,
      params.parse(request.params).id,
      revision,
    );
    return { success: true };
  });
  app.post('/clear', async (request) => {
    empty.parse(request.query);
    const input = z
      .strictObject({
        reset_context: z.boolean().default(false),
      })
      .parse(request.body === undefined ? {} : request.body);
    return clearMemory(request.user.userId, input.reset_context);
  });
  app.get('/status', async (request) => {
    empty.parse(request.query);
    return memoryStatus(request.user.userId);
  });
  app.post('/backfill', async (request) => {
    empty.parse(request.query);
    return startMemoryBackfill(
      request.user.userId,
      backfill.parse(request.body === undefined ? {} : request.body),
    );
  });
  for (const action of ['pause', 'resume'] as const)
    app.post(`/jobs/:id/${action}`, async (request) => {
      empty.parse(request.query);
      empty.parse(request.body === undefined ? {} : request.body);
      return changeMemoryJobState(
        request.user.userId,
        params.parse(request.params).id,
        action,
      );
    });
  app.post('/sources/:id/exclude', async (request) => {
    empty.parse(request.query);
    empty.parse(request.body === undefined ? {} : request.body);
    await excludeMemorySource(
      request.user.userId,
      params.parse(request.params).id,
    );
    return { success: true };
  });
}
