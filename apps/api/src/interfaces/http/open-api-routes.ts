import type { FastifyError, FastifyInstance } from 'fastify';

import { DirectPaipanError } from '#modules/chat/paipan-runtime';
import { listPublicOfficialModels } from '#modules/system/system-config';
import { listEffectiveUserSkillsForOpenApi } from '#infrastructure/repositories/skills-repository';
import {
  apiKeyAuthOnRequest,
  requireApiKeyPrincipal,
  sendOpenAiError,
} from './api-key-auth.js';
import { openPaipanRoutes } from './open-paipan-routes.js';
import { openSessionRoutes } from './open-session-routes.js';

/**
 * 对外开放 API 的 /api/v1 域父插件。
 *
 * 在此统一注入「鉴权钩子 + OpenAI 风格错误体 + no-store」——Fastify 的 hook 与
 * setErrorHandler 按封装作用域向下继承，因此其下注册的所有子路由（排盘 / chat）
 * 自动复用，无需各自重复。
 */
export async function openApiRoutes(app: FastifyInstance): Promise<void> {
  // /api/v1 域统一鉴权（对外 API Key）。失败时钩子内部已以 OpenAI 错误体响应并中断。
  app.addHook('onRequest', apiKeyAuthOnRequest);

  // /api/v1 域响应不缓存（对外数据同样不应被 CDN/浏览器复用）。
  // 注：本域已在 /api/* 下，全局 no-store 钩子其实已覆盖；这里保留一份作防御，避免日后前缀变动失守。
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // /api/v1 域统一 OpenAI 风格错误体，覆盖全局的 { error: 中文 }（OpenAI SDK 依赖此结构解析报错）。
  app.setErrorHandler((error: FastifyError, request, reply) => {
    // 排盘参数/启用类错误：携带明确 code + statusCode，原样转换。
    if (error instanceof DirectPaipanError) {
      return sendOpenAiError(
        reply,
        error.statusCode,
        error.message,
        'invalid_request_error',
        error.code,
      );
    }
    const statusCode =
      typeof error.statusCode === 'number' && error.statusCode >= 400
        ? error.statusCode
        : 500;
    if (statusCode >= 500) {
      request.log.error(
        { err: error, url: request.url },
        '对外开放 API 错误',
      );
      return sendOpenAiError(
        reply,
        500,
        '服务器内部错误',
        'api_error',
        'internal_error',
      );
    }
    return sendOpenAiError(
      reply,
      statusCode,
      error.message,
      'invalid_request_error',
      'invalid_request',
    );
  });

  // GET /api/v1/models — OpenAI 兼容的模型列表（部分 SDK 会探测可用模型）。MVP 直接列官方 model_key。
  app.get('/models', async () => {
    const models = await listPublicOfficialModels();
    return {
      object: 'list',
      data: models.map((model) => ({
        id: model.model_key,
        object: 'model',
        owned_by: 'fateclaw',
      })),
    };
  });

  // GET /api/v1/skills — 列出调用方「有效可用」的 skill（其 id 即建会话 fateclaw.skills 所需的 UUID）。
  // 与 /models 对称：调用方先在此拿到 skill id，再填入 POST /sessions 的 fateclaw.skills。
  // 口径与建会话授权完全一致（自有启用 + 订阅启用），故列出的 id 不会被 runtime 静默丢弃。
  app.get('/skills', async (request) => {
    const principal = requireApiKeyPrincipal(request);
    const skills = await listEffectiveUserSkillsForOpenApi(principal.userId);
    return {
      object: 'list',
      data: skills.map((skill) => ({
        id: skill.id,
        object: 'skill',
        name: skill.name,
        description: skill.description,
        source: skill.source,
      })),
    };
  });

  await app.register(openPaipanRoutes, { prefix: '/paipan' });
  await app.register(openSessionRoutes, { prefix: '/sessions' });
}
