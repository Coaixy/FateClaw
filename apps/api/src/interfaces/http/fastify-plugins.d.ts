import '@fastify/jwt';
import '@fastify/static';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    // JWT 中只保留认证必需的用户标识，避免在 token 中携带可变用户资料。
    payload: { userId: string };
    user: { userId: string };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    jwt: {
      sign: (
        payload: { userId: string },
        options?: { expiresIn?: string | number },
      ) => string;
    };
  }

  interface FastifyReply {
    sendFile: (filename: string) => FastifyReply;
  }

  interface FastifyRequest {
    jwtVerify: () => Promise<{ userId: string }>;
    user: { userId: string };
    // 路由按需调用此方法校验登录态，公共接口无需挂全局认证钩子。
    requireAuth: () => Promise<void>;
    // 当前管理端密钥解析出的后台身份；仅 admin 路由会写入。
    adminPrincipal?: {
      role: 'owner' | 'user_manager';
      scopes: ('admin:*' | 'users:*' | 'messages:*')[];
      home_path: '/admin/overview' | '/admin/users';
    };
  }
}
