import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV === 'development';
const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(path.dirname(webRoot));

const nextConfig: NextConfig = {
  // Web 依赖在 workspace 下会提升到仓库根 node_modules，
  // 所以 Turbopack 根需要覆盖到仓库根，而不是只停留在 apps/web/。
  turbopack: {
    root: repoRoot,
  },
  // Production: static export served by Fastify / static host.
  // 使用 trailingSlash 让导出结果落成 route/index.html，
  // 对部署环境的静态目录托管更稳，不依赖 {path}.html 特判。
  // Development: normal Next.js dev server with API proxy
  ...(isDev
    ? {
        async rewrites() {
          return [
            {
              source: '/api/:path*',
              destination: 'http://localhost:3000/api/:path*',
            },
          ];
        },
      }
    : {
        output: 'export',
        distDir: 'out',
        trailingSlash: true,
      }),
  images: {
    unoptimized: true,
  },
  // 把 Next 开发指示器移到右下角，避免遮住移动端顶部菜单。
  devIndicators: {
    position: 'bottom-right',
  },
};

export default nextConfig;
