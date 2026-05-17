import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveOfficialSkillsDir } from './official-skills-path.js';

const tempDirs: string[] = [];

function createTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fateclaw-skills-path-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveOfficialSkillsDir', () => {
  it('reads SKILLS_DIR from project .env when process env is not set', () => {
    const projectDir = createTempProject();
    const configuredDir = path.join(projectDir, 'configured-skills');
    fs.mkdirSync(configuredDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'package.json'), '{}', 'utf-8');
    fs.writeFileSync(
      path.join(projectDir, 'pnpm-workspace.yaml'),
      'packages: []\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, '.env'),
      `SKILLS_DIR=${configuredDir}\n`,
      'utf-8',
    );

    expect(
      resolveOfficialSkillsDir({
        cwd: projectDir,
        moduleDir: path.join(
          projectDir,
          'apps',
          'api',
          'dist',
          'infrastructure',
        ),
        envSkillsDir: '',
      }),
    ).toBe(configuredDir);
  });

  it('uses explicit SKILLS_DIR before probing deployment layout', () => {
    const projectDir = createTempProject();
    const configuredDir = path.join(projectDir, 'custom-skills');
    fs.mkdirSync(configuredDir, { recursive: true });

    expect(
      resolveOfficialSkillsDir({
        cwd: path.join(projectDir, 'apps', 'api'),
        moduleDir: path.join(
          projectDir,
          'apps',
          'api',
          'dist',
          'infrastructure',
        ),
        envSkillsDir: configuredDir,
      }),
    ).toBe(configuredDir);
  });

  it('finds skills/official from module path when cwd is not project root', () => {
    const projectDir = createTempProject();
    const officialDir = path.join(projectDir, 'skills', 'official');
    fs.mkdirSync(officialDir, { recursive: true });

    // Windows 服务/PM2 可能从 apps/api 启动；脚本目录应从编译后模块位置向上定位。
    expect(
      resolveOfficialSkillsDir({
        cwd: path.join(projectDir, 'apps', 'api'),
        moduleDir: path.join(
          projectDir,
          'apps',
          'api',
          'dist',
          'infrastructure',
        ),
        envSkillsDir: '',
      }),
    ).toBe(officialDir);
  });
});
