import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let rootDir = '';

vi.mock('../../infrastructure/project-root.js', () => ({
  resolveProjectRoot: () => rootDir,
}));

describe('text skill bundle store', () => {
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fateclaw-bundle-store-'));
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('writes and reads complete text bundle files with stable checksum', async () => {
    const {
      readTextSkillBundleFiles,
      writeTextSkillBundleFiles,
    } = await import('./text-skill-bundle-store.js');

    const first = writeTextSkillBundleFiles({
      skillId: 'skill-1',
      ownerId: 'user-1',
      dirName: 'my-skill',
      files: [
        {
          path: 'SKILL.md',
          content: '---\nname: My Skill\ndescription: Desc\n---\n',
        },
        { path: 'index.md', content: '# Index' },
        { path: 'docs/knowledge.md', content: 'Knowledge' },
        { path: 'examples/case.md', content: 'Case' },
        { path: 'skill.json', content: '{"name":"My Skill"}' },
        { path: 'example.sh', content: 'echo ok\n' },
      ],
    });
    const second = writeTextSkillBundleFiles({
      skillId: 'skill-1',
      ownerId: 'user-1',
      dirName: 'my-skill',
      files: [
        { path: 'examples/case.md', content: 'Case' },
        { path: 'example.sh', content: 'echo ok\n' },
        { path: 'skill.json', content: '{"name":"My Skill"}' },
        { path: 'docs/knowledge.md', content: 'Knowledge' },
        { path: 'index.md', content: '# Index' },
        {
          path: 'SKILL.md',
          content: '---\nname: My Skill\ndescription: Desc\n---\n',
        },
      ],
    });

    expect(second.checksum).toBe(first.checksum);
    expect(readTextSkillBundleFiles(first.bundleUri)).toEqual([
      { path: 'docs/knowledge.md', content: 'Knowledge' },
      { path: 'example.sh', content: 'echo ok\n' },
      { path: 'examples/case.md', content: 'Case' },
      { path: 'index.md', content: '# Index' },
      { path: 'skill.json', content: '{"name":"My Skill"}' },
      {
        path: 'SKILL.md',
        content: '---\nname: My Skill\ndescription: Desc\n---\n',
      },
    ]);
  });

  it('rejects unsafe or unsupported bundle paths', async () => {
    const { writeTextSkillBundleFiles } = await import(
      './text-skill-bundle-store.js'
    );

    expect(() =>
      writeTextSkillBundleFiles({
        skillId: 'skill-1',
        ownerId: 'user-1',
        dirName: 'bad',
        files: [
          { path: 'SKILL.md', content: '' },
          { path: '../secret.md', content: '' },
        ],
      }),
    ).toThrow(/路径|文件/);

    expect(() =>
      writeTextSkillBundleFiles({
        skillId: 'skill-1',
        ownerId: 'user-1',
        dirName: 'bad',
        files: [
          { path: 'SKILL.md', content: '' },
          { path: 'assets/image.png', content: '' },
        ],
      }),
    ).toThrow(/文本/);
  });
});
