import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveAgentSkillsDir } from './paths.js';

const tempDirs: string[] = [];

function createTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fateclaw-agent-path-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveAgentSkillsDir', () => {
  it('finds skills/official from module path when cwd is not project root', () => {
    const projectDir = createTempProject();
    const officialDir = path.join(projectDir, 'skills', 'official');
    fs.mkdirSync(officialDir, { recursive: true });

    expect(
      resolveAgentSkillsDir({
        cwd: path.join(projectDir, 'packages', 'agent-runner'),
        moduleDir: path.join(
          projectDir,
          'packages',
          'agent-runner',
          'dist',
        ),
        envSkillsDir: '',
      }),
    ).toBe(officialDir);
  });
});
