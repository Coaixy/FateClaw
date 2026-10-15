import { describe, expect, it } from 'vitest';
import {
  prepareSkillContent,
  readSkillMarkdownMetadata,
} from '../src/skills/content.js';

describe('skill content protocol', () => {
  it('canonicalizes file names and hashes multilingual files independently of input order or host locale', () => {
    const files = [
      { path: 'docs/中文.md', content: '跨区域知识' },
      { path: 'skill.md', content: '# Skill' },
      { path: 'INDEX.MD', content: '# Index' },
    ];
    const content = prepareSkillContent(files);
    expect(prepareSkillContent([...files].reverse())).toEqual(content);
    expect(content.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'docs/中文.md',
      'index.md',
    ]);
    expect(content.contentLength).toBe(
      files.reduce((sum, file) => sum + file.content.length, 0),
    );
    expect(prepareSkillContent(content.files)).toEqual(content);
    expect(() => prepareSkillContent(files, 2)).toThrow('不支持');
  });

  it.each([
    '../secret.md',
    'docs/.env',
    'C:/secret.md',
    '/secret.md',
    'docs//file.md',
    'node_modules/file.js',
    'assets/image.png',
  ])(
    'rejects invalid paths before they reach storage or materialization: %s',
    (unsafe) => {
      expect(() =>
        prepareSkillContent([
          { path: 'SKILL.md', content: '' },
          { path: unsafe, content: '' },
        ]),
      ).toThrow();
    },
  );

  it.each(['text\0with-null', '\ud800'])(
    'rejects text JSONB cannot preserve: %j',
    (content) => {
      expect(() =>
        prepareSkillContent([{ path: 'SKILL.md', content }]),
      ).toThrow('UTF-8');
    },
  );

  it('rejects canonical path collisions and missing entry points', () => {
    expect(() =>
      prepareSkillContent([
        { path: 'skill.md', content: '' },
        { path: 'SKILL.md', content: '' },
      ]),
    ).toThrow('重复');
    expect(() =>
      prepareSkillContent([{ path: 'docs/file.md', content: '' }]),
    ).toThrow('SKILL.md');
    expect(
      readSkillMarkdownMetadata(
        '---\nname: "Skill"\ndescription: "Desc"\n---\n',
        'Fallback',
      ),
    ).toEqual({ name: 'Skill', description: 'Desc' });
  });
});
