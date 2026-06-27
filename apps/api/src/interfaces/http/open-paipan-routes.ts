import type { FastifyInstance } from 'fastify';

import {
  executeDirectPaipan,
  listDirectPaipanCatalog,
} from '../../modules/chat/paipan-runtime.js';
import { requireApiKeyPrincipal, sendOpenAiError } from './api-key-auth.js';
import {
  paipanSchemaToSnakeCase,
  snakeToCamelKeysDeep,
} from './open-api-case.js';

/**
 * 对外短名 → 内部排盘 registry key 的白名单映射。
 *
 * @remarks 用显式白名单而非直接拼接 `${type}-paipan`，既防注入，也明确「哪些排盘对外开放」。
 */
const PAIPAN_TYPE_TO_SKILL_DIR: Record<string, string> = {
  bazi: 'bazi-paipan',
  iching: 'iching-paipan',
  jingzhan: 'jingzhan-paipan',
  meihua: 'meihua-paipan',
  qimen: 'qimen-paipan',
  liuren: 'liuren-paipan',
  ziwei: 'ziwei-paipan',
};

/** 内部 registry key → 对外短名（catalog 反向映射）。 */
const SKILL_DIR_TO_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(PAIPAN_TYPE_TO_SKILL_DIR).map(([type, dir]) => [dir, type]),
);

/**
 * 对外开放排盘路由（挂在 /api/v1/paipan 下，鉴权 + 错误体由父插件 openApiRoutes 统一注入）。
 *
 * 排盘是确定性纯计算：直接复用 executeDirectPaipan，跳过站内的预览缓存 / 会话写入 /
 * 客户档案预填等逻辑。零 coins 计费（与站内一致），仅受 api-key 维度限流约束。
 */
export async function openPaipanRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/paipan/catalog — 列出对外可用排盘类型及其参数 JSON-Schema。
  app.get('/catalog', async (request) => {
    const principal = requireApiKeyPrincipal(request);
    const catalog = await listDirectPaipanCatalog(principal.userId);
    return {
      paipan_types: catalog
        // 只暴露白名单内的对外排盘类型；internal-only 的项不外泄。
        .filter((item) => SKILL_DIR_TO_TYPE[item.skill])
        .map((item) => ({
          type: SKILL_DIR_TO_TYPE[item.skill],
          name: item.name,
          description: item.description,
          // 对外展示 snake_case schema（registry 内部为 camelCase）。
          parameters: paipanSchemaToSnakeCase(item.parameters),
          examples: item.examples,
        })),
    };
  });

  // POST /api/v1/paipan/:type — 执行排盘，返回 AI 可读文本 + 结构化盘面。
  app.post('/:type', async (request, reply) => {
    const principal = requireApiKeyPrincipal(request);
    const { type } = request.params as { type: string };
    const skillDir = PAIPAN_TYPE_TO_SKILL_DIR[type];
    if (!skillDir) {
      return sendOpenAiError(
        reply,
        404,
        `不支持的排盘类型: ${type}`,
        'invalid_request_error',
        'unknown_paipan_type',
      );
    }

    // 对外 snake_case → 内部 camelCase（registry schema 与校验用 camelCase）。
    const input = snakeToCamelKeysDeep(request.body ?? {}) as Record<
      string,
      unknown
    >;
    // 参数校验失败会抛 DirectPaipanError，由 /api/v1 域 errorHandler 统一转 OpenAI 风格错误体。
    const result = await executeDirectPaipan({
      accountId: 'openapi', // executeDirectPaipan 内部不消费该字段，传占位串即可。
      userId: principal.userId, // 仅用于排盘的全局启用过滤。
      skillDir,
      input,
    });
    const entry = result.skillContextEntry;
    return {
      type,
      // text：formatOfficialPaipan 生成的中文文本（稳定，适合喂给模型解读）。
      text: entry.output,
      // data：底层算法库的结构化盘面（shape 跟随 lib 版本，见设计文档 §6.3 稳定性提醒）。
      data: entry.artifactData,
    };
  });
}
