import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import path from 'path';

import { resolveProjectRoot } from '../../infrastructure/project-root.js';

const TEXT_SKILL_ROOT =
  process.env.FATECLAW_TEXT_SKILLS_DIR ||
  path.join(resolveProjectRoot(), '.fateclaw', 'text-skills');

function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function isPathInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function assertNotPiGlobalDir(dir: string): void {
  const resolved = path.resolve(dir);
  const home = process.env.HOME ? path.resolve(process.env.HOME) : null;
  if (
    home &&
    (isPathInside(resolved, path.join(home, '.pi', 'skills')) ||
      isPathInside(resolved, path.join(home, '.pi', 'agent', 'skills')))
  ) {
    throw new Error('用户私有 Skill Bundle 不能写入 Pi 全局 Skill 目录');
  }
  if (
    resolved.includes(`${path.sep}.pi${path.sep}skills${path.sep}`) ||
    resolved.includes(
      `${path.sep}.pi${path.sep}agent${path.sep}skills${path.sep}`,
    )
  ) {
    throw new Error('用户私有 Skill Bundle 不能写入 Pi 全局 Skill 目录');
  }
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

export interface TextSkillBundleWriteInput {
  skillId: string;
  ownerId: string;
  dirName: string;
  skillName: string;
  description: string;
  triggerHint: string;
  content: string;
}

export interface TextSkillBundleWriteResult {
  bundleUri: string;
  checksum: string;
}

export function resolveTextSkillBundleDir(args: {
  ownerId: string;
  skillId: string;
  dirName: string;
}): string {
  return path.join(
    TEXT_SKILL_ROOT,
    sanitizeSegment(args.ownerId) || 'unknown-owner',
    `${sanitizeSegment(args.dirName) || 'skill'}-${sanitizeSegment(args.skillId)}`,
  );
}

export function writeTextSkillBundle(
  input: TextSkillBundleWriteInput,
): TextSkillBundleWriteResult {
  const bundleDir = resolveTextSkillBundleDir({
    ownerId: input.ownerId,
    skillId: input.skillId,
    dirName: input.dirName,
  });
  assertNotPiGlobalDir(bundleDir);
  fs.mkdirSync(path.join(bundleDir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(bundleDir, 'examples'), { recursive: true });
  fs.mkdirSync(path.join(bundleDir, 'notes'), { recursive: true });

  const skillMd = [
    '---',
    `name: ${yamlScalar(input.dirName)}`,
    `description: ${yamlScalar(
      input.description || input.triggerHint || input.skillName,
    )}`,
    '---',
    '',
    `# ${input.skillName}`,
    '',
    input.description,
    '',
    input.triggerHint ? `触发提示：${input.triggerHint}` : '',
    '',
    '## 知识正文',
    '',
    '需要使用本知识时，先读取 `index.md` 查看结构，再读取 `docs/knowledge.md` 获取正文。',
  ]
    .filter(Boolean)
    .join('\n');
  const indexMd = [
    `# ${input.skillName} 索引`,
    '',
    `- docs/knowledge.md：知识正文`,
    '- examples/：案例示例',
    '- notes/：补充笔记',
  ].join('\n');

  fs.writeFileSync(path.join(bundleDir, 'SKILL.md'), skillMd);
  fs.writeFileSync(path.join(bundleDir, 'index.md'), indexMd);
  fs.writeFileSync(path.join(bundleDir, 'docs', 'knowledge.md'), input.content);

  const checksum = crypto
    .createHash('sha256')
    .update(
      [
        fs.readFileSync(path.join(bundleDir, 'SKILL.md'), 'utf-8'),
        fs.readFileSync(path.join(bundleDir, 'index.md'), 'utf-8'),
        input.content,
      ].join('\n\n'),
    )
    .digest('hex');

  return {
    bundleUri: bundleDir,
    checksum,
  };
}

export function readTextSkillBundleContent(
  bundleUri: string | null | undefined,
): string {
  const raw = bundleUri?.trim();
  if (!raw) return '';
  const bundleDir = raw.startsWith('file://') ? fileURLToPath(raw) : raw;
  const knowledgeFile = path.join(bundleDir, 'docs', 'knowledge.md');
  try {
    return fs.readFileSync(knowledgeFile, 'utf-8');
  } catch {
    return '';
  }
}
