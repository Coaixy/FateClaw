import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

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
