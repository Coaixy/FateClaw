import '@fastify/jwt';
import '@fastify/static';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    // JWT 中只保留认证必需的用户标识和令牌版本，避免携带可变用户资料。
    payload: { userId: string; authTokenVersion?: number };
    user: { userId: string; authTokenVersion?: number };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    jwt: {
      sign: (
        payload: { userId: string; authTokenVersion?: number },
        options?: { expiresIn?: string | number },
      ) => string;
    };
  }

  interface FastifyReply {
    sendFile: (filename: string) => FastifyReply;
  }

  interface FastifyRequest {
    jwtVerify: () => Promise<{ userId: string; authTokenVersion?: number }>;
    user: { userId: string; authTokenVersion?: number };
    // 路由按需调用此方法校验登录态，公共接口无需挂全局认证钩子。
    requireAuth: () => Promise<void>;
    // 当前管理端密钥解析出的后台身份；仅 admin 路由会写入。
    adminPrincipal?: {
      role: 'owner' | 'user_manager';
      scopes: ('admin:*' | 'users:read' | 'users:create' | 'messages:read')[];
      home_path: '/overview' | '/users';
    };
    // 对外开放 API Key 鉴权后解析出的调用方身份；仅 /api/v1/* 对外路由会写入。
    apiKeyPrincipal?: {
      userId: string;
      apiKeyId: string;
      keyName: string;
    };
  }
}
