import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let rootDir = '';

vi.mock('../../../src/infrastructure/project-root.js', () => ({
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
    const { readTextSkillBundleFiles, writeTextSkillBundleFiles } =
      await import('../../../src/modules/skills/text-skill-bundle-store.js');

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

  it('normalizes reserved root file names case-insensitively', async () => {
    const { readTextSkillBundleFiles, writeTextSkillBundleFiles } =
      await import('../../../src/modules/skills/text-skill-bundle-store.js');

    const result = writeTextSkillBundleFiles({
      skillId: 'skill-1',
      ownerId: 'user-1',
      dirName: 'my-skill',
      files: [
        {
          path: 'skill.md',
          content: '---\nname: Lower Skill\ndescription: Desc\n---\n',
        },
        { path: 'INDEX.MD', content: '# Index' },
        { path: 'Skill.JSON', content: '{"name":"Lower Skill"}' },
      ],
    });

    expect(readTextSkillBundleFiles(result.bundleUri)).toEqual([
      { path: 'index.md', content: '# Index' },
      { path: 'skill.json', content: '{"name":"Lower Skill"}' },
      {
        path: 'SKILL.md',
        content: '---\nname: Lower Skill\ndescription: Desc\n---\n',
      },
    ]);
  });

  it('rebases stored text-skill paths to the current project root', async () => {
    const { readTextSkillBundleFiles } = await import(
      '../../../src/modules/skills/text-skill-bundle-store.js'
    );
    const bundleDir = path.join(
      rootDir,
      '.fateclaw',
      'text-skills',
      'user-1',
      'my-skill',
    );
    fs.mkdirSync(path.join(bundleDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'SKILL.md'), '# My Skill\n');
    fs.writeFileSync(
      path.join(bundleDir, 'docs', 'knowledge.md'),
      'Knowledge',
    );

    expect(
      readTextSkillBundleFiles(
        '/app/.fateclaw/text-skills/user-1/my-skill',
      ),
    ).toEqual([
      { path: 'docs/knowledge.md', content: 'Knowledge' },
      { path: 'SKILL.md', content: '# My Skill\n' },
    ]);
  });

  it('rejects unsafe or unsupported bundle paths', async () => {
    const { writeTextSkillBundleFiles } =
      await import('../../../src/modules/skills/text-skill-bundle-store.js');

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
