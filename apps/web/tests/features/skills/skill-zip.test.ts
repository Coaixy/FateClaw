import { describe, expect, it } from 'vitest';

import { MAX_SKILL_BUNDLE_FILES } from '@fateclaw/contracts/skills';

import {
  createSkillBundleZipBlob,
  importSkillBundleFromZip,
} from '../../../features/skills/skill-zip';

async function blobToFile(blob: Blob, name: string): Promise<File> {
  return new File([await blob.arrayBuffer()], name, {
    type: 'application/zip',
  });
}

async function renameZipPath(
  blob: Blob,
  from: string,
  to: string,
): Promise<File> {
  const fromBytes = new TextEncoder().encode(from);
  const toBytes = new TextEncoder().encode(to);
  if (fromBytes.length !== toBytes.length) {
    throw new Error('测试 ZIP 文件名替换必须保持相同长度');
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let replacementCount = 0;
  for (let offset = 0; offset <= bytes.length - fromBytes.length; offset += 1) {
    const matched = fromBytes.every(
      (byte, index) => bytes[offset + index] === byte,
    );
    if (!matched) continue;
    bytes.set(toBytes, offset);
    replacementCount += 1;
  }
  if (replacementCount === 0) {
    throw new Error('测试 ZIP 内没有找到待替换文件名');
  }
  return blobToFile(new Blob([bytes], { type: 'application/zip' }), 'skill.zip');
}

describe('skill zip import/export', () => {
  it('round-trips text skill files through zip', async () => {
    const blob = createSkillBundleZipBlob([
      {
        path: 'SKILL.md',
        content: [
          '---',
          'name: "六爻测试 Skill"',
          'description: "用于测试"',
          '---',
          '',
          '# 六爻测试 Skill',
        ].join('\n'),
      },
      {
        path: 'index.md',
        content: '# 索引',
      },
      {
        path: 'docs/knowledge.md',
        content: '# 正文',
      },
      {
        path: 'skill.json',
        content: '{"name":"manifest-skill"}',
      },
      {
        path: 'example.sh',
        content: 'echo ok\n',
      },
    ]);

    const imported = await importSkillBundleFromZip(
      await blobToFile(blob, 'skill.zip'),
    );

    expect(imported.skillName).toBe('manifest-skill');
    expect(imported.files).toEqual([
      {
        path: 'docs/knowledge.md',
        content: '# 正文',
      },
      {
        path: 'example.sh',
        content: 'echo ok\n',
      },
      {
        path: 'index.md',
        content: '# 索引',
      },
      {
        path: 'skill.json',
        content: '{"name":"manifest-skill"}',
      },
      {
        path: 'SKILL.md',
        content: [
          '---',
          'name: "六爻测试 Skill"',
          'description: "用于测试"',
          '---',
          '',
          '# 六爻测试 Skill',
        ].join('\n'),
      },
    ]);
  });

  it('normalizes lowercase root skill markdown during import', async () => {
    const blob = createSkillBundleZipBlob([
      {
        path: 'SKILL.md',
        content: [
          '---',
          'name: "小写入口 Skill"',
          'description: ""',
          '---',
          '',
          '# 小写入口 Skill',
        ].join('\n'),
      },
    ]);

    const imported = await importSkillBundleFromZip(
      await renameZipPath(blob, 'SKILL.md', 'skill.md'),
    );

    expect(imported.skillName).toBe('小写入口 Skill');
    expect(imported.files).toEqual([
      {
        path: 'SKILL.md',
        content: [
          '---',
          'name: "小写入口 Skill"',
          'description: ""',
          '---',
          '',
          '# 小写入口 Skill',
        ].join('\n'),
      },
    ]);
  });

  it('does not inject template files during import', async () => {
    const blob = createSkillBundleZipBlob([
      {
        path: 'SKILL.md',
        content: [
          '---',
          'name: "Root Skill"',
          'description: ""',
          '---',
          '',
          '# Root Skill',
        ].join('\n'),
      },
      {
        path: 'docs/knowledge.md',
        content: '# Root Knowledge',
      },
    ]);
    const imported = await importSkillBundleFromZip(
      await blobToFile(blob, 'root.zip'),
    );

    expect(imported.files.map((file) => file.path)).toEqual([
      'docs/knowledge.md',
      'SKILL.md',
    ]);
  });

  it('does not reject bundles by total text length', async () => {
    const files = [
      {
        path: 'SKILL.md',
        content: '---\nname: "Large Skill"\ndescription: ""\n---\n',
      },
      {
        path: 'docs/a.md',
        content: 'a'.repeat(60_000),
      },
      {
        path: 'docs/b.md',
        content: 'b'.repeat(60_000),
      },
    ];

    const imported = await importSkillBundleFromZip(
      await blobToFile(createSkillBundleZipBlob(files), 'large.zip'),
    );

    expect(imported.files).toHaveLength(3);
  });

  it('rejects bundles with too many text files', () => {
    const files = [
      {
        path: 'SKILL.md',
        content: '# Skill',
      },
      ...Array.from({ length: MAX_SKILL_BUNDLE_FILES }, (_, index) => ({
        path: `docs/${index}.md`,
        content: String(index),
      })),
    ];

    expect(() => createSkillBundleZipBlob(files)).toThrow(
      String(MAX_SKILL_BUNDLE_FILES),
    );
  });

  it('rejects a single file over the character limit', () => {
    expect(() =>
      createSkillBundleZipBlob([
        {
          path: 'SKILL.md',
          content: '# Skill',
        },
        {
          path: 'docs/large.md',
          content: 'x'.repeat(100_001),
        },
      ]),
    ).toThrow(/100000/);
  });

  it('uses configured limits when importing bundles', async () => {
    const blob = createSkillBundleZipBlob(
      [
        {
          path: 'SKILL.md',
          content: '# Skill',
        },
        {
          path: 'docs/a.md',
          content: '# A',
        },
      ],
      {
        max_files: 2,
        max_file_chars: 100,
        max_total_chars: 200,
        max_zip_bytes: 8 * 1024 * 1024,
      },
    );

    await expect(
      importSkillBundleFromZip(await blobToFile(blob, 'skill.zip'), {
        max_files: 1,
        max_file_chars: 100,
        max_total_chars: 200,
        max_zip_bytes: 8 * 1024 * 1024,
      }),
    ).rejects.toThrow('压缩包内文本文件不超过 1 个');
  });
});
