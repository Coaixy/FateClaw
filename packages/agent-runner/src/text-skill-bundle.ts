import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const BUNDLE_MARKDOWN_DIRS = ['docs', 'examples', 'notes'];
const MAX_BUNDLE_FILES = 80;
const MAX_BUNDLE_CHARS = 240_000;

function isPathInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function containsForbiddenPiGlobalPath(dir: string): boolean {
  const normalized = path.resolve(dir);
  const home = process.env.HOME ? path.resolve(process.env.HOME) : null;
  const forbidden = [
    path.join('.pi', 'skills'),
    path.join('.pi', 'agent', 'skills'),
  ];

  if (
    home &&
    (isPathInside(normalized, path.join(home, '.pi', 'skills')) ||
      isPathInside(normalized, path.join(home, '.pi', 'agent', 'skills')))
  ) {
    return true;
  }

  return forbidden.some((segment) =>
    normalized.includes(`${path.sep}${segment}${path.sep}`),
  );
}

export function resolveTextSkillBundleDir(
  bundleUri: string | null | undefined,
): string | null {
  const raw = bundleUri?.trim();
  if (!raw) return null;

  let resolved: string;
  if (raw.startsWith('file://')) {
    try {
      resolved = fileURLToPath(raw);
    } catch {
      return null;
    }
  } else {
    resolved = raw;
  }

  const absolute = path.resolve(resolved);
  if (containsForbiddenPiGlobalPath(absolute)) return null;
  if (!fs.existsSync(path.join(absolute, 'SKILL.md'))) return null;
  return absolute;
}

function collectMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  const pushIfFile = (filePath: string) => {
    if (
      files.length < MAX_BUNDLE_FILES &&
      fs.existsSync(filePath) &&
      fs.statSync(filePath).isFile() &&
      path.extname(filePath).toLowerCase() === '.md'
    ) {
      files.push(filePath);
    }
  };

  pushIfFile(path.join(dir, 'SKILL.md'));
  pushIfFile(path.join(dir, 'index.md'));

  const walk = (root: string) => {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (files.length >= MAX_BUNDLE_FILES) return;
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(fullPath);
      }
    }
  };

  for (const subdir of BUNDLE_MARKDOWN_DIRS) {
    walk(path.join(dir, subdir));
  }

  return files;
}

export function getTextSkillBundleSkillFile(
  bundleUri: string | null | undefined,
): { baseDir: string; filePath: string } | null {
  const baseDir = resolveTextSkillBundleDir(bundleUri);
  if (!baseDir) return null;
  return {
    baseDir,
    filePath: path.join(baseDir, 'SKILL.md'),
  };
}

export function readTextSkillBundleMarkdown(
  bundleUri: string | null | undefined,
): string {
  const baseDir = resolveTextSkillBundleDir(bundleUri);
  if (!baseDir) return '';

  const chunks: string[] = [];
  let totalChars = 0;
  for (const filePath of collectMarkdownFiles(baseDir)) {
    if (totalChars >= MAX_BUNDLE_CHARS) break;
    const relative = path.relative(baseDir, filePath);
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) continue;
    const remaining = MAX_BUNDLE_CHARS - totalChars;
    const body =
      content.length > remaining
        ? `${content.slice(0, remaining)}\n\n[已截断：Text Skill Bundle 超过 ${MAX_BUNDLE_CHARS} 字符]`
        : content;
    chunks.push(`<!-- ${relative} -->\n${body}`);
    totalChars += body.length;
  }

  return chunks.join('\n\n');
}
