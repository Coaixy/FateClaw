import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV === 'development';
const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(path.dirname(webRoot));

/**
 * 只从仓库根 .env 读取前端明确需要公开的变量，避免把服务端密钥注入 Web bundle。
 *
 * @param name 需要读取的环境变量名。
 * @returns 已解析的变量值；未配置时返回 undefined。
 */
function readRepoRootEnvValue(name: string): string | undefined {
  const valueFromProcess = process.env[name]?.trim();
  if (valueFromProcess) return valueFromProcess;

  const envPath = path.join(repoRoot, '.env');
  if (!fs.existsSync(envPath)) return undefined;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex < 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    if (key !== name) continue;

    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    return rawValue.replace(/^['"]|['"]$/g, '');
  }

  return undefined;
}

const nextConfig: NextConfig = {
  // Web 依赖在 workspace 下会提升到仓库根 node_modules，
  // 所以 Turbopack 根需要覆盖到仓库根，而不是只停留在 apps/web/。
  turbopack: {
    root: repoRoot,
  },
  // Compile shared workspace contracts with the application.
  transpilePackages: ['@fateclaw/contracts'],
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
  env: {
    NEXT_PUBLIC_TELEGRAM_CHANNEL_URL:
      readRepoRootEnvValue('NEXT_PUBLIC_TELEGRAM_CHANNEL_URL') ?? '',
    // 开发者 API 文档展示用的 API 公网基址：直接复用后端那份 PUBLIC_API_BASE_URL
    // （即对外 /api/v1、/api 实际挂载的公网地址），未配置时回退到通用 PUBLIC_BASE_URL。
    // 取配置而非浏览器 origin，避免在「web 与 API 不同源」时把 web 地址当成 API 地址。
    NEXT_PUBLIC_OPEN_API_BASE_URL:
      readRepoRootEnvValue('PUBLIC_API_BASE_URL') ??
      readRepoRootEnvValue('PUBLIC_BASE_URL') ??
      '',
  },
  // 把 Next 开发指示器移到右下角，避免遮住移动端顶部菜单。
  devIndicators: {
    position: 'bottom-right',
  },
};

export default nextConfig;
