import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [
    {
      name: 'workspace-next-app-alias',
      async resolveId(source, importer, options) {
        if (!source.startsWith('@/') || !importer) return null;

        const normalizedImporter = importer.split(path.sep).join('/');
        const appName = normalizedImporter.includes('/apps/web/')
          ? 'web'
          : normalizedImporter.includes('/apps/admin/')
            ? 'admin'
            : null;
        if (!appName) return null;

        // 根 Vitest 同时运行多个 Next app 测试，@/ 需要按导入方所在 app 解析。
        const target = path.resolve(repoRoot, 'apps', appName, source.slice(2));
        return (
          (await this.resolve(target, importer, {
            ...options,
            skipSelf: true,
          })) ?? target
        );
      },
    },
  ],
  test: {
    include: [
      'apps/**/tests/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}',
      'packages/**/tests/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}',
      'tests/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '.pnpm-store/**',
      '.worktrees/**',
      'apps/agent-runtime/dist/**',
    ],
  },
});
