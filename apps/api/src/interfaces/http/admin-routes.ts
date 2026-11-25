import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { adminIssueRoutes } from './issues-routes.js';
import { adminAnnouncementRoutes } from './announcements-routes.js';
import { adminRegistrationInviteRoutes } from './registration-invite-routes.js';
import { MANAGER_KEY, USER_MANAGER_KEY } from '#infrastructure/config';
import {
  rateLimitCheck,
  rateLimitRecordFail,
  rateLimitClear,
} from './rate-limit.js';
import { adminSystemRoutes } from './admin-system-routes.js';
import { adminBillingRoutes } from './admin-billing-routes.js';
import { adminUsersRoutes } from './admin-users-routes.js';
import { adminConversationRoutes } from './admin-conversation-routes.js';
import { adminSkillsRoutes } from './admin-skills-routes.js';

type AdminRole = 'owner' | 'user_manager';
type AdminScope = 'admin:*' | 'users:read' | 'users:create' | 'messages:read';
type AdminHomePath = '/overview' | '/users';

interface AdminPrincipal {
  role: AdminRole;
  scopes: AdminScope[];
  home_path: AdminHomePath;
}

const OWNER_ADMIN_PRINCIPAL: AdminPrincipal = {
  role: 'owner',
  scopes: ['admin:*'],
  home_path: '/overview',
};

const USER_MANAGER_ADMIN_PRINCIPAL: AdminPrincipal = {
  role: 'user_manager',
  scopes: ['users:read', 'users:create', 'messages:read'],
  home_path: '/users',
};

const USER_MANAGER_ALLOWED_ROUTES = new Map<string, AdminScope>([
  ['GET /users', 'users:read'],
  ['POST /users', 'users:create'],
  ['GET /users/:id', 'users:read'],
  ['GET /users/:id/transactions', 'users:read'],
  ['GET /users/:id/balance/grants', 'users:read'],
  ['GET /messages', 'messages:read'],
  ['GET /chat-sessions', 'messages:read'],
]);

function normalizeAdminRouteUrl(
  routeUrl: string | undefined,
): string | undefined {
  if (!routeUrl) return routeUrl;
  // Fastify 带 prefix 注册插件时会把前缀并入 routeOptions.url，权限表统一用插件内路径维护。
  if (routeUrl.startsWith('/api/admin')) {
    return routeUrl.slice('/api/admin'.length) || '/';
  }
  return routeUrl;
}

function cloneAdminPrincipal(principal: AdminPrincipal): AdminPrincipal {
  return {
    role: principal.role,
    scopes: [...principal.scopes],
    home_path: principal.home_path,
  };
}

function resolveAdminPrincipal(key: string | undefined): AdminPrincipal | null {
  if (key && MANAGER_KEY && key === MANAGER_KEY) {
    return cloneAdminPrincipal(OWNER_ADMIN_PRINCIPAL);
  }
  if (key && USER_MANAGER_KEY && key === USER_MANAGER_KEY) {
    return cloneAdminPrincipal(USER_MANAGER_ADMIN_PRINCIPAL);
  }
  return null;
}

function getRequiredAdminScope(
  method: string,
  routeUrl: string | undefined,
): AdminScope | null {
  const normalizedRouteUrl = normalizeAdminRouteUrl(routeUrl);
  if (normalizedRouteUrl === '/verify') return null;
  return (
    USER_MANAGER_ALLOWED_ROUTES.get(`${method} ${normalizedRouteUrl}`) ??
    'admin:*'
  );
}

function hasAdminScope(
  principal: AdminPrincipal,
  required: AdminScope,
): boolean {
  return (
    principal.scopes.includes('admin:*') || principal.scopes.includes(required)
  );
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // 所有 admin 路由需要验证后台密钥，并对失败鉴权统一做指数退避限流。
  app.addHook('onRequest', async (request, reply) => {
    if (!MANAGER_KEY && !USER_MANAGER_KEY) {
      return reply.code(503).send({ error: '管理端未配置密钥' });
    }

    const ipHash = crypto
      .createHash('sha256')
      .update(request.ip)
      .digest('hex')
      .slice(0, 16);
    const rateKey = `admin:${ipHash}`;
    const check = await rateLimitCheck(rateKey);
    if (!check.allowed) {
      request.log.warn(
        { ipHash, retryAfterMs: check.retryAfterMs },
        'admin auth rate limited',
      );
      return reply
        .code(429)
        .header('Retry-After', Math.ceil((check.retryAfterMs ?? 1000) / 1000))
        .send({ error: '尝试过于频繁，请稍后再试' });
    }

    const rawKey = request.headers['x-admin-key'];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    const principal = resolveAdminPrincipal(key);
    if (!principal) {
      await rateLimitRecordFail(rateKey);
      return reply.code(401).send({ error: '管理密钥无效' });
    }

    request.adminPrincipal = principal;
    await rateLimitClear(rateKey);
  });

  app.addHook('preHandler', async (request, reply) => {
    const principal = request.adminPrincipal;
    if (!principal) {
      return reply.code(401).send({ error: '管理密钥无效' });
    }

    const required = getRequiredAdminScope(
      request.method,
      request.routeOptions.url,
    );
    if (required && !hasAdminScope(principal, required)) {
      return reply.code(403).send({ error: '无权访问该管理功能' });
    }
  });

  await app.register(adminIssueRoutes, { prefix: '/issues' });
  await app.register(adminAnnouncementRoutes, { prefix: '/announcements' });
  await app.register(adminRegistrationInviteRoutes, {
    prefix: '/registration-invites',
  });

  // POST /api/admin/verify — 验证密钥是否正确
  app.post('/verify', async (request) => {
    const principal = request.adminPrincipal ?? OWNER_ADMIN_PRINCIPAL;
    return {
      success: true,
      role: principal.role,
      scopes: principal.scopes,
      home_path: principal.home_path,
    };
  });

  await app.register(adminSystemRoutes);
  await app.register(adminBillingRoutes);
  await app.register(adminUsersRoutes);
  await app.register(adminConversationRoutes);
  await app.register(adminSkillsRoutes);
}
