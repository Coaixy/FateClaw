import fs from 'fs';
import path from 'path';

import Fastify, { FastifyError, FastifyInstance } from 'fastify';
import fastifyCors, { type FastifyCorsOptions } from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';

import { JWT_SECRET } from '../../infrastructure/config.js';
import { logger } from '../../infrastructure/logger.js';
import { resolveProjectRoot } from '../../infrastructure/project-root.js';
import { accountRoutes } from './account-routes.js';
import { adminRoutes } from './admin-routes.js';
import { authRoutes } from './auth-routes.js';
import { billingRoutes } from './billing-routes.js';
import { chatSessionsRoutes } from './chat-sessions-routes.js';
import { messagesRoutes } from './messages-routes.js';
import { modelSettingsRoutes } from './model-settings-routes.js';
import { paipanRoutes } from './paipan-routes.js';
import { publicRoutes } from './public-routes.js';
import { registerAiChatStreamWebSocket } from '../../runtime/ai-chat-stream.js';

import { normalizeHttpError } from './http-error.js';
import { skillsRoutes } from './skills-routes.js';
import { resolveStaticExportRequest } from './static-export.js';
import { tasksRoutes } from './tasks-routes.js';
const API_PORT = parseInt(process.env.API_PORT || '3000', 10);
const API_HOST = process.env.API_HOST || '0.0.0.0';
const IMMUTABLE_STATIC_ASSET_PATTERN =
  /(?:^|[/\\])_next[/\\]static[/\\]|(?:^|[/\\])static[/\\]chunks[/\\]/;

export async function createApiServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // use our own pino logger
  });

  // Allow empty body with application/json content-type
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        const str = (body as string) || '';
        done(null, str ? JSON.parse(str) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && allowedOrigins.length === 0) {
    throw new Error(
      'ALLOWED_ORIGINS 未配置：生产环境必须显式声明跨域白名单（逗号分隔）。',
    );
  }
  const corsOptions: FastifyCorsOptions = {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // 同源 / curl / server-to-server
      if (allowedOrigins.includes(origin)) return cb(null, true);
      if (
        !isProd &&
        (/^https?:\/\/localhost(:\d+)?$/.test(origin) ||
          /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin))
      ) {
        return cb(null, true);
      }
      cb(null, false);
    },
    credentials: true,
  };
  await app.register(fastifyCors, corsOptions);

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;

    // 用户态 API 数据不能被 CDN 或浏览器复用，否则会出现删除会话、充值余额等状态回退。
    reply.header(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    );
    reply.header('CDN-Cache-Control', 'no-store');
    reply.header('Surrogate-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
    reply.header('Expires', '0');
    reply.header('Vary', 'Origin, Authorization, Cookie');
  });

  await app.register(fastifyJwt, {
    secret: JWT_SECRET,
  });
  registerAiChatStreamWebSocket(app);

  // Auth decorator — routes call request.requireAuth() to enforce JWT
  app.decorateRequest('requireAuth', async () => {
    // placeholder, overridden by onRequest hook
  });

  app.addHook('onRequest', async (request) => {
    request.requireAuth = async () => {
      try {
        await request.jwtVerify();
      } catch {
        const err = new Error('未登录或 token 已过期');
        (err as Error & { statusCode: number }).statusCode = 401;
        throw err;
      }
    };
  });

  // Request logging — only log errors (4xx/5xx)
  app.addHook('onResponse', (request, reply, done) => {
    if (reply.statusCode >= 400) {
      logger.warn(
        {
          method: request.method,
          url: request.url,
          status: reply.statusCode,
          ms: Math.round(reply.elapsedTime),
        },
        `${request.method} ${request.url} ${reply.statusCode}`,
      );
    }
    done();
  });

  // Error handler — log + return JSON
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const normalizedError = normalizeHttpError(error);
    const status = normalizedError.statusCode;
    if (status >= 500) {
      logger.error(
        { err: error, method: request.method, url: request.url },
        `API 错误: ${request.method} ${request.url}`,
      );
    } else {
      logger.warn(
        {
          status,
          message: error.message,
          method: request.method,
          url: request.url,
        },
        `API ${status}: ${request.method} ${request.url}`,
      );
    }
    reply.status(status).send({ error: normalizedError.publicMessage });
  });

  // Register routes
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(accountRoutes, { prefix: '/api/account' });
  await app.register(chatSessionsRoutes, { prefix: '/api/chat-sessions' });
  await app.register(messagesRoutes, { prefix: '/api/messages' });
  await app.register(modelSettingsRoutes, { prefix: '/api/model-settings' });
  await app.register(paipanRoutes, { prefix: '/api/paipan' });
  await app.register(publicRoutes, { prefix: '/api/public' });
  await app.register(tasksRoutes, { prefix: '/api/tasks' });
  await app.register(skillsRoutes, { prefix: '/api/skills' });

  await app.register(billingRoutes, { prefix: '/api/billing' });

  // Liveness：进程是否存活，不依赖外部组件，k8s livenessProbe 用
  app.get('/api/health', async () => ({ status: 'ok' }));

  // Readiness：进程是否能服务流量。任一外部依赖不可用即返回 503，
  // k8s readinessProbe 用此摘除有故障的副本。
  app.get('/api/ready', async (_req, reply) => {
    const checks: Record<string, 'ok' | string> = {};
    let healthy = true;
    try {
      const { pingDatabase } = await import('../../infrastructure/db.js');
      await pingDatabase();
      checks.postgres = 'ok';
    } catch (err) {
      healthy = false;
      checks.postgres = err instanceof Error ? err.message : 'down';
    }
    try {
      const { getRedis } = await import('../../infrastructure/redis.js');
      await getRedis().ping();
      checks.redis = 'ok';
    } catch (err) {
      healthy = false;
      checks.redis = err instanceof Error ? err.message : 'down';
    }
    if (!healthy) {
      return reply.code(503).send({ status: 'unhealthy', checks });
    }
    return { status: 'ready', checks };
  });

  // Serve static frontend (apps/web/out/) if it exists
  const webOutDir = path.resolve(resolveProjectRoot(), 'apps', 'web', 'out');
  if (fs.existsSync(webOutDir)) {
    await app.register(fastifyStatic, {
      root: webOutDir,
      prefix: '/',
      wildcard: false,
      setHeaders: (response, filePath) => {
        if (IMMUTABLE_STATIC_ASSET_PATTERN.test(filePath)) {
          response.setHeader(
            'Cache-Control',
            'public, max-age=31536000, immutable',
          );
          return;
        }

        response.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      },
    });

    // 兼容生产静态导出的三类请求：
    // 1. 直开页面时的 {path}/index.html 或旧版 {path}.html
    // 2. App Router 客户端跳转时的 {path}.txt 路由数据短路径
    // 3. 真正缺失的静态资源返回 404，不能错误兜底成首页
    app.setNotFoundHandler(async (request, reply) => {
      const resolution = resolveStaticExportRequest(request.url);

      if (resolution.kind === 'api-404') {
        return reply.code(404).send({ error: 'Not Found' });
      }

      for (const candidateFile of resolution.candidateFiles) {
        const fullPath = path.join(webOutDir, candidateFile);
        if (fs.existsSync(fullPath)) {
          return reply.sendFile(candidateFile);
        }
      }

      if (resolution.fallbackToIndexHtml) {
        return reply.sendFile('index.html');
      }

      return reply
        .code(404)
        .type('text/plain; charset=utf-8')
        .send('Not Found');
    });
  }

  return app;
}

export async function startApiServer(): Promise<FastifyInstance> {
  const app = await createApiServer();

  await app.listen({ port: API_PORT, host: API_HOST });
  logger.info(`API server listening on ${API_HOST}:${API_PORT}`);

  return app;
}
