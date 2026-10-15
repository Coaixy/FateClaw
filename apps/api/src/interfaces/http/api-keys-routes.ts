import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  ApiKeyCreatedDto,
  ListApiKeysResponse,
  MAX_API_KEYS_PER_USER,
} from '@fateclaw/contracts/api-keys';

import {
  countActiveUserApiKeys,
  createUserApiKey,
  getMembershipOverview,
  listUserApiKeys,
  revokeUserApiKey,
  toApiKeyDto,
} from '../../infrastructure/db.js';

/** 生成 API Key 的请求体校验。 */
const CreateApiKeySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'API Key 名称不能为空')
    .max(50, '名称最多 50 个字符'),
  // 可选过期时间（ISO 8601 带时区）；不传表示永不过期。
  expires_at: z.string().datetime({ offset: true }).nullable().optional(),
});

/**
 * 对外开放 API Key 的「管理」路由（站内，JWT 鉴权）。
 *
 * 用户在网页端登录态下生成 / 列出 / 吊销自己的 key。注意：这里是「管理面」，
 * 与「调用面」（/api/v1/* 用 key 鉴权）分离；本路由沿用内部统一的 { error: 中文 } 错误体。
 */
export async function apiKeysRoutes(app: FastifyInstance): Promise<void> {
  // 全部 key 管理接口要求登录态。
  app.addHook('onRequest', async (request) => {
    await request.requireAuth();
  });

  // POST /api/api-keys — 生成 key。会员专属；明文仅在本响应返回一次。
  app.post('/', async (request, reply) => {
    const userId = request.user.userId;

    // Creating a key requires an active membership; existing keys have separate authentication.
    const membership = await getMembershipOverview(userId);
    if (!membership.active) {
      return reply
        .code(403)
        .send({ error: '仅会员可生成 API Key，请先开通会员' });
    }

    const parsed = CreateApiKeySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message ?? '参数无效' });
    }

    // 过期时间若提供，必须晚于当前时间。
    if (parsed.data.expires_at) {
      const expiresAt = new Date(parsed.data.expires_at);
      if (expiresAt.getTime() <= Date.now()) {
        return reply.code(400).send({ error: '过期时间必须晚于当前时间' });
      }
    }

    // 数量上限：避免单账户无限生成。
    const activeCount = await countActiveUserApiKeys(userId);
    if (activeCount >= MAX_API_KEYS_PER_USER) {
      return reply.code(400).send({
        error: `每个账户最多持有 ${MAX_API_KEYS_PER_USER} 个有效 API Key，请先吊销不用的 key`,
      });
    }

    const { row, plaintext } = await createUserApiKey({
      userId,
      name: parsed.data.name,
      expiresAt: parsed.data.expires_at ?? null,
    });

    const response: ApiKeyCreatedDto = { ...toApiKeyDto(row), key: plaintext };
    return reply.code(201).send(response);
  });

  // GET /api/api-keys — 列出当前用户全部 key（脱敏，含已吊销）。
  app.get('/', async (request): Promise<ListApiKeysResponse> => {
    const rows = await listUserApiKeys(request.user.userId);
    return { api_keys: rows.map(toApiKeyDto) };
  });

  // DELETE /api/api-keys/:id — 吊销自己名下的某个 key。
  app.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const revoked = await revokeUserApiKey({
      userId: request.user.userId,
      keyId: id,
    });
    if (!revoked) {
      return reply.code(404).send({ error: 'API Key 不存在或已吊销' });
    }
    return { success: true };
  });
}
