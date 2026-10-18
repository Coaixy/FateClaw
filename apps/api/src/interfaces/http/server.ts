import fs from 'fs';
import path from 'path';

import Fastify, {
  FastifyError,
  FastifyInstance,
  FastifyRequest,
} from 'fastify';
import fastifyCors, { type FastifyCorsOptions } from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import fastifyCompress from '@fastify/compress';

import {
  ALLOWED_ORIGINS,
  JWT_SECRET,
  PUBLIC_WEB_BASE_URL,
  TRUST_PROXY,
} from '#infrastructure/config';
import { getUserById } from '#infrastructure/db';
import { logger } from '#infrastructure/logger';
import { resolveProjectRoot } from '#infrastructure/project-root';
import { accountRoutes } from './account-routes.js';
import { adminRoutes } from './admin-routes.js';
import { apiKeysRoutes } from './api-keys-routes.js';
import { authRoutes } from './auth-routes.js';
import { registrationInviteRoutes } from './registration-invite-routes.js';
import { billingRoutes } from './billing-routes.js';
import { chatSessionsRoutes } from './chat-sessions-routes.js';
import { clientProfilesRoutes } from './client-profiles-routes.js';
import { messagesRoutes } from './messages-routes.js';
import { modelSettingsRoutes } from './model-settings-routes.js';
import { serviceStatusRoutes } from './service-status-routes.js';
import { issuesRoutes } from './issues-routes.js';
import { announcementRoutes } from './announcements-routes.js';
import { openApiRoutes } from './open-api-routes.js';
import { openSessionsAdminRoutes } from './open-sessions-admin-routes.js';
import { paipanRoutes } from './paipan-routes.js';
import { registerAiChatStreamWebSocket } from '#runtime/ai-chat-stream';

import { normalizeHttpError } from './http-error.js';
import { skillsRoutes } from './skills-routes.js';
import { resolveStaticExportRequest } from './static-export.js';
const API_PORT = parseInt(process.env.API_PORT || '3000', 10);
const API_HOST = process.env.API_HOST || '0.0.0.0';
const IMMUTABLE_STATIC_ASSET_PATTERN =
  /(?:^|[/\\])_next[/\\]static[/\\]|(?:^|[/\\])static[/\\]chunks[/\\]/;
const ROUTE_DOCUMENT_FILE_PATTERN =
  /(?:^|[/\\])(?:index|[^/\\]+)\.(?:html|txt)$/i;
const FONT_ASSET_URL_PATTERN =
  /^\/_next\/static\/media\/[^?#]+\.(?:ttf|otf|woff2?|eot)$/i;
const FONT_ASSET_FILE_PATTERN =
  /(?:^|[/\\])_next[/\\]static[/\\]media[/\\].+\.(?:ttf|otf|woff2?|eot)$/i;

function requestLogUrl(request: FastifyRequest): string {
  // Stream credentials, invitation codes and issue search text must stay out of request logs.
  return /^(?:\/login(?:[/?]|$)|\/api\/auth\/invites(?:[/?]|$)|\/api\/admin\/registration-invites(?:[/?]|$)|\/api\/chat-sessions\/s\/[^/?]+\/stream(?:\?|$)|\/api\/(?:admin\/)?issues(?:[/?]|$))/.test(
    request.url,
  )
    ? request.url.split('?')[0]
    : request.url;
}

function unauthorizedError(): Error & { statusCode: number } {
  const err = new Error('未登录或 token 已过期') as Error & {
    statusCode: number;
  };
  err.statusCode = 401;
  return err;
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function normalizeOrigin(value: string | null): string | null {
  if (!value || value === 'null') return null;

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function requestHostOrigin(request: FastifyRequest): string | null {
  const forwardedHost = firstHeaderValue(request.headers['x-forwarded-host']);
  const host = forwardedHost ?? firstHeaderValue(request.headers.host);
  if (!host) return null;

  const forwardedProto = firstHeaderValue(request.headers['x-forwarded-proto']);
  const proto = forwardedProto?.split(',')[0]?.trim() || request.protocol;
  return normalizeOrigin(`${proto}://${host}`);
}

function isFontAssetUrl(rawUrl: string): boolean {
  try {
    return FONT_ASSET_URL_PATTERN.test(
      new URL(rawUrl, 'http://local').pathname,
    );
  } catch {
    return false;
  }
}

function setNoStoreHeaders(reply: {
  header(name: string, value: string): unknown;
}) {
  reply.header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
  );
  reply.header('CDN-Cache-Control', 'no-store');
  reply.header('Surrogate-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
  reply.header('Expires', '0');
}

function setNoStoreResponseHeaders(response: {
  setHeader(name: string, value: string): void;
}) {
  response.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
  );
  response.setHeader('CDN-Cache-Control', 'no-store');
  response.setHeader('Surrogate-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Expires', '0');
}

function isPrematureStreamCloseError(error: FastifyError): boolean {
  const code = (error as FastifyError & { code?: unknown }).code;
  return (
    code === 'ERR_STREAM_PREMATURE_CLOSE' || error.message === 'Premature close'
  );
}

function isTrustedStaticAssetOrigin(
  origin: string | null,
  requestOrigin: string | null,
  allowedOrigins: string[],
): boolean {
  if (!origin) return true;
  return origin === requestOrigin || allowedOrigins.includes(origin);
}

function shouldBlockFontAssetRequest(
  request: FastifyRequest,
  allowedOrigins: string[],
): boolean {
  const fetchSite = firstHeaderValue(request.headers['sec-fetch-site']);
  if (fetchSite === 'cross-site') return true;
  if (fetchSite === 'same-origin') return false;

  const requestOrigin = requestHostOrigin(request);
  const origin = normalizeOrigin(firstHeaderValue(request.headers.origin));
  const referer = normalizeOrigin(firstHeaderValue(request.headers.referer));
  if (!origin && !referer) return true;

  return (
    !isTrustedStaticAssetOrigin(origin, requestOrigin, allowedOrigins) ||
    !isTrustedStaticAssetOrigin(referer, requestOrigin, allowedOrigins)
  );
}

export async function createApiServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // use our own pino logger
    // 信任反向代理以还原真实客户端 IP；否则 request.ip 取到代理 IP，
    // 所有按 IP 的限流/验证码绑定/登录爆破锁定会坍缩成全局单桶。
    trustProxy: TRUST_PROXY,
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
        // JSON.parse errors may quote credentials from the request body.
        if (err instanceof SyntaxError) {
          done(
            Object.assign(new Error('请求体不是合法的 JSON'), {
              statusCode: 400,
              code: 'FST_ERR_CTP_INVALID_JSON_BODY',
            }),
            undefined,
          );
        } else {
          done(err as Error, undefined);
        }
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

  // PUBLIC_WEB_BASE_URL 已经是显式配置的用户站点公开来源，默认加入 CORS 白名单。
  const allowedOrigins = Array.from(
    new Set([...ALLOWED_ORIGINS, PUBLIC_WEB_BASE_URL].filter(Boolean)),
  );
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && allowedOrigins.length === 0) {
    throw new Error(
      'ALLOWED_ORIGINS 或 PUBLIC_WEB_BASE_URL 未配置：生产环境必须显式声明跨域白名单。',
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
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  };
  await app.register(fastifyCors, corsOptions);
  await app.register(fastifyCompress, {
    global: true,
    encodings: ['br', 'gzip'],
    threshold: 1024,
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;

    // 用户态 API 数据不能被 CDN 或浏览器复用，否则会出现删除会话、充值积分等状态回退。
    setNoStoreHeaders(reply);
    reply.header('Vary', 'Origin, Authorization, Cookie');
  });

  await app.register(fastifyJwt, {
    secret: JWT_SECRET,
  });
  await registerAiChatStreamWebSocket(app);

  // Auth decorator — routes call request.requireAuth() to enforce JWT
  app.decorateRequest('requireAuth', async () => {
    // placeholder, overridden by onRequest hook
  });

  app.addHook('onRequest', async (request) => {
    request.requireAuth = async () => {
      try {
        await request.jwtVerify();
      } catch {
        throw unauthorizedError();
      }

      const authUser = request.user as {
        userId: string;
        authTokenVersion?: unknown;
      };
      if (typeof authUser.authTokenVersion !== 'number') {
        throw unauthorizedError();
      }

      const user = (await getUserById(authUser.userId)) as
        | { auth_token_version?: number }
        | undefined;
      if (
        !user ||
        (user.auth_token_version ?? 0) !== authUser.authTokenVersion
      ) {
        throw unauthorizedError();
      }
    };
  });

  // Request logging — only log errors (4xx/5xx)
  app.addHook('onResponse', (request, reply, done) => {
    if (reply.statusCode >= 400) {
      logger.warn(
        {
          method: request.method,
          url: requestLogUrl(request),
          status: reply.statusCode,
          ms: Math.round(reply.elapsedTime),
        },
        `${request.method} ${requestLogUrl(request)} ${reply.statusCode}`,
      );
    }
    done();
  });

  // Error handler — log + return JSON
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (isPrematureStreamCloseError(error)) {
      // 客户端或代理提前断开时，压缩流会抛出 ERR_STREAM_PREMATURE_CLOSE。
      // 这类错误不代表业务处理失败，按断连记录，避免污染 500 告警。
      logger.warn(
        {
          code: (error as FastifyError & { code?: unknown }).code,
          method: request.method,
          url: requestLogUrl(request),
        },
        `客户端提前断开连接: ${request.method} ${requestLogUrl(request)}`,
      );
      return reply.status(499).send({ error: '客户端已断开连接' });
    }

    const normalizedError = normalizeHttpError(error);
    const status = normalizedError.statusCode;
    if (status >= 500) {
      logger.error(
        { err: error, method: request.method, url: requestLogUrl(request) },
        `API 错误: ${request.method} ${requestLogUrl(request)}`,
      );
    } else {
      logger.warn(
        {
          status,
          message: error.message,
          method: request.method,
          url: requestLogUrl(request),
        },
        `API ${status}: ${request.method} ${requestLogUrl(request)}`,
      );
    }
    reply.status(status).send({ error: normalizedError.publicMessage });
  });

  // Register routes
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(registrationInviteRoutes, { prefix: '/api/auth/invites' });
  await app.register(accountRoutes, { prefix: '/api/account' });
  await app.register(chatSessionsRoutes, { prefix: '/api/chat-sessions' });
  await app.register(clientProfilesRoutes, { prefix: '/api/client-profiles' });
  await app.register(messagesRoutes, { prefix: '/api/messages' });
  await app.register(modelSettingsRoutes, { prefix: '/api/model-settings' });
  await app.register(serviceStatusRoutes, { prefix: '/api/service-status' });
  await app.register(issuesRoutes, { prefix: '/api/issues' });
  await app.register(announcementRoutes, { prefix: '/api/announcements' });
  await app.register(paipanRoutes, { prefix: '/api/paipan' });
  await app.register(skillsRoutes, { prefix: '/api/skills' });

  await app.register(billingRoutes, { prefix: '/api/billing' });

  // 对外开放 API：会员用 api-key 程序化调用排盘/Agent。
  // /api/api-keys 是站内管理面（JWT 鉴权）；/api/v1 是对外调用面（api-key 鉴权 + OpenAI 风格错误体）。
  // 挂在 /api/v1 而非顶层 /v1：与全站 /api/* 一致，天然走现有 dev 代理与生产反代规则，无需额外配置。
  await app.register(apiKeysRoutes, { prefix: '/api/api-keys' });
  // 站内「API 使用详情」面板：用户查看自己经 API Key 创建的会话与对话（JWT 鉴权）。
  await app.register(openSessionsAdminRoutes, { prefix: '/api/open-sessions' });
  await app.register(openApiRoutes, { prefix: '/api/v1' });

  // Liveness：进程是否存活，不依赖外部组件，k8s livenessProbe 用
  app.get('/api/health', async () => ({ status: 'ok' }));

  // Readiness：进程是否能服务流量。任一外部依赖不可用即返回 503，
  // k8s readinessProbe 用此摘除有故障的副本。
  app.get('/api/ready', async (_req, reply) => {
    const checks: Record<string, 'ok' | string> = {};
    let healthy = true;
    try {
      const { pingDatabase } = await import('#infrastructure/db');
      await pingDatabase();
      checks.postgres = 'ok';
    } catch (err) {
      healthy = false;
      checks.postgres = err instanceof Error ? err.message : 'down';
    }
    try {
      const { getRedis } = await import('#infrastructure/redis');
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
    app.addHook('onRequest', async (request, reply) => {
      if (!isFontAssetUrl(request.url)) return;

      // 字体文件体积很大，跨站嵌入时先在源站兜底拦截，避免被当成公共 CDN 使用。
      if (!shouldBlockFontAssetRequest(request, allowedOrigins)) return;

      return reply
        .code(403)
        .type('text/plain; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .header('Cross-Origin-Resource-Policy', 'same-origin')
        .send('Forbidden');
    });

    await app.register(fastifyStatic, {
      root: webOutDir,
      prefix: '/',
      wildcard: false,
      cacheControl: false,
      setHeaders: (response, filePath) => {
        if (FONT_ASSET_FILE_PATTERN.test(filePath)) {
          response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
          response.setHeader('Vary', 'Origin, Referer, Sec-Fetch-Site');
        }

        if (IMMUTABLE_STATIC_ASSET_PATTERN.test(filePath)) {
          response.setHeader(
            'Cache-Control',
            'public, max-age=31536000, immutable',
          );
          return;
        }

        // 静态导出的 HTML 和 App Router 路由数据必须回源，避免 CDN 长时间发旧页面壳。
        if (ROUTE_DOCUMENT_FILE_PATTERN.test(filePath)) {
          setNoStoreResponseHeaders(response);
          return;
        }

        response.setHeader(
          'Cache-Control',
          'public, max-age=0, must-revalidate',
        );
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
          if (ROUTE_DOCUMENT_FILE_PATTERN.test(candidateFile)) {
            setNoStoreHeaders(reply);
          }

          return reply.sendFile(candidateFile);
        }
      }

      if (resolution.fallbackToIndexHtml) {
        setNoStoreHeaders(reply);
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
