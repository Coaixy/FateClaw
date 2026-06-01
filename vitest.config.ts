import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '.pnpm-store/**',
      '.worktrees/**',
      'apps/agent-runtime/dist/**',
    ],
  },
});
