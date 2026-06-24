import type { FastifyInstance } from 'fastify';

import {
  getBaziCaseDetail,
  getBaziCasesOverviewService,
  listBaziCases,
} from '../../modules/bazi-cases/bazi-cases-service.js';
import { fixedWindowRateLimit } from './rate-limit.js';

/** 开放查询接口的按 IP 限流额度（每分钟）。 */
const RATE_LIMIT_PER_MIN = 60;
/** 固定窗口长度（秒）。 */
const RATE_WINDOW_SEC = 60;

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseIntOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** 列表接口的 query 参数（Fastify 解析后均为字符串）。 */
interface ListQuery {
  gender?: string;
  marriage?: string;
  wealth?: string;
  education?: string;
  job_type?: string;
  q?: string;
  limit?: string;
  offset?: string;
}

/**
 * 注册八字命例数据集的「开放查询」HTTP 路由（全部免登录、对外开放）。
 *
 * 这是只读公开数据：
 * - 对所有来源放开 CORS（简单 GET 不触发预检，onSend 盖一个 Access-Control-Allow-Origin: * 即可），
 *   不影响全局白名单对其它接口的保护；
 * - 加按 IP 固定窗口限流，防止被一次性爬空或刷爆。
 */
export async function baziCasesRoutes(app: FastifyInstance): Promise<void> {
  // 对外放开跨域：去掉凭证、允许任意 origin 读取公开数据
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.removeHeader('Access-Control-Allow-Credentials');
    return payload;
  });

  // 按 IP 限流（request.ip 由 Fastify trustProxy 解析，不再手读可伪造的 X-Forwarded-For）
  app.addHook('onRequest', async (request, reply) => {
    const { allowed, retryAfterSec } = await fixedWindowRateLimit(
      `bazicases:${request.ip}`,
      RATE_LIMIT_PER_MIN,
      RATE_WINDOW_SEC,
    );
    if (!allowed) {
      reply.header('Retry-After', String(retryAfterSec));
      return reply.code(429).send({ error: '请求过于频繁，请稍后再试' });
    }
  });

  // GET /api/bazi-cases — 命例列表（筛选 + 分页）
  app.get<{ Querystring: ListQuery }>('/', async (request, reply) => {
    const query = request.query;
    const result = await listBaziCases({
      gender: trimOrUndefined(query.gender),
      marriage: trimOrUndefined(query.marriage),
      wealth: trimOrUndefined(query.wealth),
      education: trimOrUndefined(query.education),
      jobType: trimOrUndefined(query.job_type),
      q: trimOrUndefined(query.q),
      limit: parseIntOrUndefined(query.limit),
      offset: parseIntOrUndefined(query.offset),
    });
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // GET /api/bazi-cases/overview — 统计概览（各维度分布）
  app.get('/overview', async (_request, reply) => {
    const result = await getBaziCasesOverviewService();
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // GET /api/bazi-cases/:id — 命例详情（含大运）。静态 /overview 优先匹配，不冲突。
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: '非法 id' });
    }
    const result = await getBaziCaseDetail(id);
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });
}
