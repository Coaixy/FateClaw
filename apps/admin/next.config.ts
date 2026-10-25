import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';
import { createReleaseLicensePlugin } from '../../scripts/write-release-notices.mjs';

const isDev = process.env.NODE_ENV === 'development';
const adminRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(path.dirname(adminRoot));

const nextConfig: NextConfig = {
  webpack(config, { isServer }) {
    if (!isServer && !isDev) config.plugins.push(createReleaseLicensePlugin());
    return config;
  },
  // Admin 依赖在 workspace 下会提升到仓库根 node_modules，
  // 所以 Turbopack 根需要覆盖到仓库根，而不是只停留在 apps/admin/。
  turbopack: {
    root: repoRoot,
  },
  transpilePackages: ['@fateclaw/contracts', 'fateclaw-web'],
  // 生产环境：静态导出后交给独立 admin 静态站点托管。
  // 使用 trailingSlash 让导出结果落成 route/index.html，
  // 对部署环境的静态目录托管更稳，不依赖 {path}.html 特判。
  // 开发环境：使用 Next.js dev server，并把 API 请求代理到本地 API 站。
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
};

export default nextConfig;
