import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

let require = createRequire(new URL('../apps/web/package.json', import.meta.url));
for (const name of ['eslint-config-next', '@next/eslint-plugin-next', 'fast-glob', 'micromatch']) {
  require = createRequire(require.resolve(name));
}
const braces = require('braces');
const globRequire = createRequire(createRequire(new URL('../apps/web/package.json', import.meta.url)).resolve('eslint-config-next'));
const pluginRequire = createRequire(globRequire.resolve('@next/eslint-plugin-next'));
const fastGlob = pluginRequire('fast-glob');

describe('braces dependency security patch', () => {
  it.each(['compile', 'expand', 'stringify'])('bounds %s recursion for string and direct AST inputs', (operation) => {
    const pattern = `${'{'.repeat(3000)}a,b${'}'.repeat(3000)}`;
    const ast = braces.parse(pattern);
    const message = 'brace AST nesting exceeds maximum supported depth (128)';
    expect(() => braces[operation](pattern)).toThrow(message);
    expect(() => braces[operation](ast)).toThrow(message);
  });

  it('preserves ordinary brace globs used by the Next.js lint dependency', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fateclaw-glob-test-'));
    try {
      for (const file of ['src/api/index.ts', 'src/web/page.tsx', 'src/web/notes.md']) {
        const filename = path.join(directory, file);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, 'fixture');
      }
      expect(fastGlob.sync('src/{api,web}/**/*.{ts,tsx}', { cwd: directory }).sort()).toEqual([
        'src/api/index.ts',
        'src/web/page.tsx',
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
