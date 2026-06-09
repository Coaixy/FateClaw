import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveProjectRoot } from '../../src/infrastructure/project-root.js';

const tempDirs: string[] = [];

function createTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fateclaw-project-root-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), '{}', 'utf-8');
  fs.writeFileSync(
    path.join(dir, 'pnpm-workspace.yaml'),
    'packages: []\n',
    'utf-8',
  );
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveProjectRoot', () => {
  it('finds project root from compiled module path when cwd is elsewhere', () => {
    const projectDir = createTempProject();

    expect(
      resolveProjectRoot({
        cwd: path.join(projectDir, 'apps', 'api'),
        moduleDir: path.join(
          projectDir,
          'apps',
          'api',
          'dist',
          'infrastructure',
        ),
      }),
    ).toBe(projectDir);
  });
});
