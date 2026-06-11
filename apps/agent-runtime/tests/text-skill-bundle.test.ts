import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getTextSkillBundleSkillFile } from '../src/text-skill-bundle.js';

const originalProjectRoot = process.env.FATECLAW_PROJECT_ROOT;
const originalTextSkillsDir = process.env.FATECLAW_TEXT_SKILLS_DIR;

function createSkillBundle(root: string, ...segments: string[]): string {
  const bundleDir = path.join(root, '.fateclaw', 'text-skills', ...segments);
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, 'SKILL.md'), '# 测试 Skill\n');
  return bundleDir;
}

describe('text skill bundle resolver', () => {
  afterEach(() => {
    if (originalProjectRoot === undefined) {
      delete process.env.FATECLAW_PROJECT_ROOT;
    } else {
      process.env.FATECLAW_PROJECT_ROOT = originalProjectRoot;
    }
    if (originalTextSkillsDir === undefined) {
      delete process.env.FATECLAW_TEXT_SKILLS_DIR;
    } else {
      process.env.FATECLAW_TEXT_SKILLS_DIR = originalTextSkillsDir;
    }
  });

  it('rebases container text-skill paths to the local project root', () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'fateclaw-project-root-'),
    );
    const bundleDir = createSkillBundle(
      projectRoot,
      'user-1',
      'private-liuyao',
    );
    process.env.FATECLAW_PROJECT_ROOT = projectRoot;
    delete process.env.FATECLAW_TEXT_SKILLS_DIR;

    const result = getTextSkillBundleSkillFile(
      '/app/.fateclaw/text-skills/user-1/private-liuyao',
    );

    expect(result).toEqual({
      baseDir: bundleDir,
      filePath: path.join(bundleDir, 'SKILL.md'),
    });
  });
});
