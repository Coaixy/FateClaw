import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  createClientProfileForOwnedUser,
  deleteClientProfileForOwnedUser,
  getClientProfileForOwnedUser,
  listClientProfilesForOwnedUser,
  updateClientProfileForOwnedUser,
} from '../../modules/chat/client-profile-service.js';

/** 阳历生日 YYYY-MM-DD 格式校验。 */
const SOLAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 客户档案创建/更新请求体校验。
 *
 * @remarks 与契约 ClientProfileUpsertDto 对齐：name 必填；gender 限定 '男'/'女'；
 *          hour 0-23、minute 0-59；solar_date 走 YYYY-MM-DD 正则；可空字段允许 null。
 */
const ClientProfileUpsertSchema = z.object({
  name: z.string().trim().min(1, '请填写客户姓名').max(64),
  gender: z.enum(['男', '女']).nullable().optional(),
  solar_date: z
    .string()
    .trim()
    .regex(SOLAR_DATE_PATTERN, '出生日期格式应为 YYYY-MM-DD')
    .nullable()
    .optional(),
  hour: z.number().int().min(0).max(23).nullable().optional(),
  minute: z.number().int().min(0).max(59).nullable().optional(),
  birthplace: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  // 轻量 CRM：自由标签(最多12个,单个≤20字)与状态(vip/待跟进/已完成)。
  tags: z.array(z.string().trim().min(1).max(20)).max(12).optional(),
  status: z.enum(['vip', 'follow_up', 'done']).nullable().optional(),
});

/**
 * 注册客户档案 HTTP 路由。
 *
 * @param app Fastify 实例。
 * @returns 路由注册完成后返回。
 */
export async function clientProfilesRoutes(app: FastifyInstance): Promise<void> {
  // 全部接口都要求登录，且只操作当前用户名下的客户。
  app.addHook('onRequest', async (request) => {
    await request.requireAuth();
  });

  // GET /api/client-profiles — 列出当前用户的全部在档客户
  app.get('/', async (request, reply) => {
    const result = await listClientProfilesForOwnedUser(request.user.userId);
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return { clients: result.data };
  });

  // POST /api/client-profiles — 创建客户档案
  app.post<{
    Body: unknown;
  }>('/', async (request, reply) => {
    const parsed = ClientProfileUpsertSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    const result = await createClientProfileForOwnedUser(
      request.user.userId,
      parsed.data,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // GET /api/client-profiles/:id — 读取单个客户档案
  app.get<{
    Params: { id: string };
  }>('/:id', async (request, reply) => {
    const result = await getClientProfileForOwnedUser(
      request.user.userId,
      request.params.id,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // PUT /api/client-profiles/:id — 更新客户档案
  app.put<{
    Params: { id: string };
    Body: unknown;
  }>('/:id', async (request, reply) => {
    const parsed = ClientProfileUpsertSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    const result = await updateClientProfileForOwnedUser(
      request.user.userId,
      request.params.id,
      parsed.data,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // DELETE /api/client-profiles/:id — 软删除客户档案
  app.delete<{
    Params: { id: string };
  }>('/:id', async (request, reply) => {
    const result = await deleteClientProfileForOwnedUser(
      request.user.userId,
      request.params.id,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });
}
