import type { FastifyInstance, FastifyRequest } from 'fastify';

import { getRedis } from '../../infrastructure/redis.js';
import {
  getBaziCaseDetail,
  getBaziCasesOverviewService,
  listBaziCases,
} from '../../modules/bazi-cases/bazi-cases-service.js';

/** 开放查询接口的按 IP 限流额度（每分钟）。 */
const RATE_LIMIT_PER_MIN = 60;
/** 固定窗口长度（秒）。 */
const RATE_WINDOW_SEC = 60;

/** 取客户端 IP：优先 X-Forwarded-For 首个（反代后），回退 socket ip。 */
function clientIp(request: FastifyRequest): string {
  const xff = request.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  if (raw) {
    const first = raw.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.ip;
}

/**
 * 固定窗口计数限流：每分钟一个桶，超过额度即拒绝。
 *
 * @remarks Redis 不可用时 fail-open（放行）——公开只读数据优先保证可用性，
 *          限流只是防刷不是鉴权。
 */
async function checkRateLimit(
  ip: string,
): Promise<{ allowed: boolean; retryAfter: number }> {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(nowSec / RATE_WINDOW_SEC);
    const key = `bazicases:rl:${ip}:${bucket}`;
    const redis = getRedis();
    const count = await redis.incr(key);
    if (count === 1) {
      // 新桶设过期，避免 key 无限增长
      await redis.expire(key, RATE_WINDOW_SEC);
    }
    if (count > RATE_LIMIT_PER_MIN) {
      return {
        allowed: false,
        retryAfter: RATE_WINDOW_SEC - (nowSec % RATE_WINDOW_SEC),
      };
    }
    return { allowed: true, retryAfter: 0 };
  } catch {
    return { allowed: true, retryAfter: 0 };
  }
}

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

  // 按 IP 限流
  app.addHook('onRequest', async (request, reply) => {
    const { allowed, retryAfter } = await checkRateLimit(clientIp(request));
    if (!allowed) {
      reply.header('Retry-After', String(retryAfter));
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
