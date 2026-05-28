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

const ALLOWED_BUNDLE_ROOTS = new Set(['docs', 'examples', 'notes']);
export interface TextSkillBundleFile {
  path: string;
  content: string;
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

export interface TextSkillBundleFilesWriteInput {
  skillId: string;
  ownerId: string;
  dirName: string;
  files: TextSkillBundleFile[];
  fallbackSkillName?: string;
}

export interface SkillMarkdownMetadata {
  name: string;
  description: string;
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

function resolveBundleUri(bundleUri: string | null | undefined): string | null {
  const raw = bundleUri?.trim();
  if (!raw) return null;
  const resolved = raw.startsWith('file://') ? fileURLToPath(raw) : raw;
  const absolute = path.resolve(resolved);
  assertNotPiGlobalDir(absolute);
  return absolute;
}

export function normalizeTextSkillBundlePath(rawPath: string): string {
  const input = rawPath.trim();
  if (!input) throw new Error('文件路径不能为空');
  if (input.includes('\\')) throw new Error('文件路径不能包含反斜杠');
  if (path.posix.isAbsolute(input) || path.isAbsolute(input)) {
    throw new Error('文件路径必须是相对路径');
  }

  const normalized = path.posix.normalize(input);
  if (normalized !== input || normalized.startsWith('../')) {
    throw new Error('文件路径不能包含 .. 或重复分隔符');
  }
  if (!normalized.endsWith('.md')) {
    throw new Error('Skill Bundle 只支持 Markdown 文件');
  }

  const segments = normalized.split('/');
  if (
    segments.some(
      (segment) =>
        !segment || segment === '.' || segment === '..' || segment.startsWith('.'),
    )
  ) {
    throw new Error('文件路径不能包含隐藏或危险目录');
  }

  if (normalized === 'SKILL.md' || normalized === 'index.md') {
    return normalized;
  }
  if (!ALLOWED_BUNDLE_ROOTS.has(segments[0])) {
    throw new Error('文件只能放在 docs、examples 或 notes 目录下');
  }

  return normalized;
}

function createDefaultSkillMarkdown(
  skillName: string,
  description = '',
): string {
  return [
    '---',
    `name: ${yamlScalar(skillName)}`,
    `description: ${yamlScalar(description || `${skillName} Skill`)}`,
    '---',
    '',
    `# ${skillName}`,
    '',
    description,
    '',
    '## 入口说明',
    '',
    '按 `index.md` 的文件索引读取相关 Markdown 内容。',
    '',
    '## 推荐读取顺序',
    '',
    '- `index.md`',
    '- `docs/knowledge.md`',
  ]
    .filter(Boolean)
    .join('\n');
}

function createDefaultIndexMarkdown(skillName: string): string {
  return [
    `# ${skillName} 文件索引`,
    '',
    '- `SKILL.md`：Skill 入口说明与读取边界',
    '- `docs/knowledge.md`：主要知识正文',
    '- `examples/`：案例示例',
    '- `notes/`：补充笔记',
  ].join('\n');
}

function normalizeTextSkillBundleFiles(
  files: TextSkillBundleFile[],
  fallbackSkillName: string,
): TextSkillBundleFile[] {
  const byPath = new Map<string, string>();

  for (const file of files) {
    const safePath = normalizeTextSkillBundlePath(file.path);
    if (byPath.has(safePath)) {
      throw new Error(`重复的文件路径：${safePath}`);
    }
    byPath.set(safePath, file.content ?? '');
  }

  if (!byPath.has('SKILL.md')) {
    throw new Error('Skill Bundle 必须包含 SKILL.md');
  }
  if (!byPath.has('index.md')) {
    byPath.set('index.md', createDefaultIndexMarkdown(fallbackSkillName));
  }
  if (!byPath.has('docs/knowledge.md')) {
    byPath.set('docs/knowledge.md', '');
  }

  return Array.from(byPath.entries())
    .map(([filePath, content]) => ({ path: filePath, content }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function getSkillMarkdownMetadata(
  skillMd: string,
  fallbackName: string,
): SkillMarkdownMetadata {
  const frontmatterMatch = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const metadata: Record<string, string> = {};

  if (frontmatterMatch) {
    for (const line of frontmatterMatch[1].split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!match) continue;
      const rawValue = match[2].trim();
      if (
        (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'"))
      ) {
        try {
          metadata[match[1]] = JSON.parse(rawValue);
          continue;
        } catch {
          metadata[match[1]] = rawValue.slice(1, -1);
          continue;
        }
      }
      metadata[match[1]] = rawValue;
    }
  }

  return {
    name: (metadata.name || fallbackName).trim(),
    description: (metadata.description || '').trim(),
  };
}

export function calculateTextSkillBundleChecksum(
  files: TextSkillBundleFile[],
): string {
  const hash = crypto.createHash('sha256');
  for (const file of [...files].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function writeFilesToBundleDir(
  bundleDir: string,
  files: TextSkillBundleFile[],
): string {
  assertNotPiGlobalDir(bundleDir);
  const parentDir = path.dirname(bundleDir);
  fs.mkdirSync(parentDir, { recursive: true });
  const tempDir = path.join(
    parentDir,
    `.tmp-${path.basename(bundleDir)}-${crypto.randomUUID()}`,
  );

  try {
    for (const file of files) {
      const targetPath = path.join(tempDir, file.path);
      const resolved = path.resolve(targetPath);
      if (!isPathInside(resolved, tempDir)) {
        throw new Error('文件路径越界');
      }
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, file.content);
    }
    fs.rmSync(bundleDir, { recursive: true, force: true });
    fs.renameSync(tempDir, bundleDir);
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }

  return calculateTextSkillBundleChecksum(files);
}

export function writeTextSkillBundleFiles(
  input: TextSkillBundleFilesWriteInput,
): TextSkillBundleWriteResult {
  const bundleDir = resolveTextSkillBundleDir({
    ownerId: input.ownerId,
    skillId: input.skillId,
    dirName: input.dirName,
  });
  const files = normalizeTextSkillBundleFiles(
    input.files,
    input.fallbackSkillName || input.dirName,
  );
  const checksum = writeFilesToBundleDir(bundleDir, files);

  return {
    bundleUri: bundleDir,
    checksum,
  };
}

export function writeTextSkillBundle(
  input: TextSkillBundleWriteInput,
): TextSkillBundleWriteResult {
  const skillMd = createDefaultSkillMarkdown(
    input.skillName,
    input.description || input.triggerHint || input.skillName,
  );
  const legacySkillMd = input.triggerHint
    ? `${skillMd}\n\n## 旧入口说明\n\n${input.triggerHint.trim()}\n`
    : skillMd;

  return writeTextSkillBundleFiles({
    skillId: input.skillId,
    ownerId: input.ownerId,
    dirName: input.dirName,
    fallbackSkillName: input.skillName,
    files: [
      {
        path: 'SKILL.md',
        content: legacySkillMd,
      },
      {
        path: 'index.md',
        content: createDefaultIndexMarkdown(input.skillName),
      },
      {
        path: 'docs/knowledge.md',
        content: input.content,
      },
    ],
  });
}

function readAllowedMarkdownFilesFromDir(bundleDir: string): TextSkillBundleFile[] {
  const files: TextSkillBundleFile[] = [];

  function pushFile(relativePath: string): void {
    const safePath = normalizeTextSkillBundlePath(relativePath);
    const absolutePath = path.join(bundleDir, safePath);
    files.push({
      path: safePath,
      content: fs.readFileSync(absolutePath, 'utf-8'),
    });
  }

  for (const fileName of ['SKILL.md', 'index.md']) {
    const absolutePath = path.join(bundleDir, fileName);
    if (fs.existsSync(absolutePath)) pushFile(fileName);
  }

  for (const root of ALLOWED_BUNDLE_ROOTS) {
    const rootDir = path.join(bundleDir, root);
    if (!fs.existsSync(rootDir)) continue;
    const walk = (currentDir: string) => {
      for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const entryPath = path.join(currentDir, entry.name);
        const relativePath = path.relative(bundleDir, entryPath).split(path.sep).join('/');
        if (entry.isDirectory()) {
          walk(entryPath);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith('.md')) {
          pushFile(relativePath);
        }
      }
    };
    walk(rootDir);
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function readTextSkillBundleFiles(
  bundleUri: string | null | undefined,
): TextSkillBundleFile[] {
  const bundleDir = resolveBundleUri(bundleUri);
  if (!bundleDir) return [];
  try {
    return readAllowedMarkdownFilesFromDir(bundleDir);
  } catch {
    return [];
  }
}

export function readTextSkillBundleContent(
  bundleUri: string | null | undefined,
): string {
  const files = readTextSkillBundleFiles(bundleUri);
  const knowledge = files.find((file) => file.path === 'docs/knowledge.md');
  return knowledge?.content ?? '';
}

export function getTextSkillBundleContentLength(
  bundleUri: string | null | undefined,
): number {
  return readTextSkillBundleFiles(bundleUri).reduce(
    (sum, file) => sum + file.content.length,
    0,
  );
}

export function appendLegacyTriggerHintToSkillBundle(
  bundleUri: string | null | undefined,
  triggerHint: string | null | undefined,
): string | null {
  const hint = triggerHint?.trim();
  if (!hint) return null;
  const bundleDir = resolveBundleUri(bundleUri);
  if (!bundleDir) return null;

  const files = readTextSkillBundleFiles(bundleDir);
  const skillFile = files.find((file) => file.path === 'SKILL.md');
  if (!skillFile) return null;
  if (skillFile.content.includes(hint)) {
    return calculateTextSkillBundleChecksum(files);
  }

  const updatedFiles = files.map((file) =>
    file.path === 'SKILL.md'
      ? {
          ...file,
          content: `${file.content.trimEnd()}\n\n## 旧入口说明\n\n${hint}\n`,
        }
      : file,
  );
  try {
    return writeFilesToBundleDir(bundleDir, updatedFiles);
  } catch {
    return '';
  }
}
