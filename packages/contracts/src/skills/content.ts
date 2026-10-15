// Server-only content protocol shared by the API and agent-runtime.
import { createHash } from 'node:crypto';
import path from 'node:path';

export const SKILL_CONTENT_FORMAT_VERSION = 1;

export interface SkillContentFile {
  path: string;
  content: string;
}

export interface SkillContent {
  formatVersion: number;
  checksum: string;
  contentLength: number;
  files: SkillContentFile[];
}

export interface SkillRevisionRef {
  skillId: string;
  revisionId: string;
  formatVersion: number;
  checksum: string;
}

export interface SkillContentRevision extends SkillRevisionRef {
  contentLength: number;
  files: SkillContentFile[];
}

export class SkillContentValidationError extends Error {}

const extensions = new Set([
  '.md',
  '.mdx',
  '.json',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.sh',
  '.py',
  '.txt',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.conf',
  '.csv',
  '.tsv',
  '.xml',
  '.html',
  '.css',
  '.sql',
]);
const blockedDirectories = new Set([
  '__MACOSX',
  '__pycache__',
  'node_modules',
  'dist',
  'build',
  'coverage',
]);

function validText(value: string): boolean {
  return (
    !value.includes('\0') &&
    Buffer.from(value, 'utf8').toString('utf8') === value
  );
}

export function normalizeSkillContentPath(value: string): string {
  const input = value.trim();
  if (
    !input ||
    !validText(input) ||
    input.includes('\\') ||
    path.posix.isAbsolute(input) ||
    /^[A-Za-z]:/.test(input) ||
    path.posix.normalize(input) !== input ||
    input
      .split('/')
      .some(
        (segment) =>
          !segment ||
          segment.startsWith('.') ||
          blockedDirectories.has(segment),
      )
  ) {
    throw new SkillContentValidationError(
      '文件路径必须是安全的 UTF-8 相对路径',
    );
  }
  if (!extensions.has(path.posix.extname(input).toLowerCase())) {
    throw new SkillContentValidationError('Skill 只支持文本文件');
  }
  if (!input.includes('/')) {
    if (input.toLowerCase() === 'skill.md') return 'SKILL.md';
    if (input.toLowerCase() === 'skill.json') return 'skill.json';
    if (input.toLowerCase() === 'index.md') return 'index.md';
  }
  return input;
}

export function prepareSkillContent(
  files: SkillContentFile[],
  formatVersion = SKILL_CONTENT_FORMAT_VERSION,
): SkillContent {
  if (formatVersion !== SKILL_CONTENT_FORMAT_VERSION) {
    throw new SkillContentValidationError(
      `不支持的 Skill 内容格式：${formatVersion}`,
    );
  }
  const byPath = new Map<string, string>();
  for (const file of files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      typeof file.content !== 'string' ||
      !validText(file.content)
    ) {
      throw new SkillContentValidationError(
        'Skill 文件必须包含有效且不含空字符的 UTF-8 文本',
      );
    }
    const normalized = normalizeSkillContentPath(file.path);
    if (byPath.has(normalized))
      throw new SkillContentValidationError(`重复的文件路径：${normalized}`);
    byPath.set(normalized, file.content);
  }
  if (!byPath.has('SKILL.md'))
    throw new SkillContentValidationError('Skill 必须包含 SKILL.md');
  const normalized = [...byPath]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([filePath, content]) => ({ path: filePath, content }));
  const hash = createHash('sha256').update(
    `fateclaw-skill-content\0${formatVersion}\0`,
  );
  for (const file of normalized)
    hash.update(file.path).update('\0').update(file.content).update('\0');
  return {
    formatVersion,
    checksum: hash.digest('hex'),
    contentLength: normalized.reduce(
      (sum, file) => sum + file.content.length,
      0,
    ),
    files: normalized,
  };
}

export function readSkillMarkdownMetadata(
  skillMd: string,
  fallbackName: string,
): { name: string; description: string } {
  const frontmatter = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const metadata: Record<string, string> = {};
  for (const line of frontmatter?.[1].split(/\r?\n/) ?? []) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const raw = match[2].trim();
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      metadata[match[1]] = raw.slice(1, -1);
      if (raw.startsWith('"')) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed === 'string') metadata[match[1]] = parsed;
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
      }
    } else {
      metadata[match[1]] = raw;
    }
  }
  return {
    name: (metadata.name || fallbackName).trim(),
    description: (metadata.description || '').trim(),
  };
}
