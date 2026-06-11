import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const TEXT_SKILL_MARKER = '/.fateclaw/text-skills/';

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

function hasSkillMarkdown(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'SKILL.md'));
}

function uniqueResolvedDirs(dirs: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      dirs
        .map((dir) => dir?.trim())
        .filter((dir): dir is string => Boolean(dir))
        .map((dir) => path.resolve(dir)),
    ),
  );
}

function getLocalTextSkillRoots(): string[] {
  return uniqueResolvedDirs([
    process.env.FATECLAW_TEXT_SKILLS_DIR,
    process.env.FATECLAW_PROJECT_ROOT
      ? path.join(process.env.FATECLAW_PROJECT_ROOT, '.fateclaw', 'text-skills')
      : undefined,
    path.join(process.cwd(), '.fateclaw', 'text-skills'),
  ]);
}

function rebaseTextSkillBundleDir(absolute: string): string[] {
  const normalized = absolute.replace(/\\/g, '/');
  const markerIndex = normalized.indexOf(TEXT_SKILL_MARKER);
  if (markerIndex < 0) return [];

  const suffix = normalized
    .slice(markerIndex + TEXT_SKILL_MARKER.length)
    .split('/')
    .filter(Boolean);
  if (suffix.length === 0) return [];

  return getLocalTextSkillRoots().map((root) => path.join(root, ...suffix));
}

/**
 * 解析数据库中的 Text Skill Bundle 地址。
 *
 * @param bundleUri 数据库存储的 bundle_uri，可为本地绝对路径或 file:// URI。
 * @returns 当前 agent-runtime 进程可读取的 Skill 目录；不存在 SKILL.md 时返回 null。
 * @remarks 兼容历史/容器路径：当 DB 里是 /app/.fateclaw/text-skills/... 但本机项目根不同，
 * 会把 .fateclaw/text-skills 之后的相对段重映射到当前项目根。
 */
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
  const candidates = uniqueResolvedDirs([
    absolute,
    ...rebaseTextSkillBundleDir(absolute),
  ]);
  for (const candidate of candidates) {
    if (containsForbiddenPiGlobalPath(candidate)) continue;
    if (hasSkillMarkdown(candidate)) return candidate;
  }
  return null;
}

/**
 * 读取 Text Skill Bundle 的入口文件信息。
 *
 * @param bundleUri 数据库存储的 bundle_uri。
 * @returns 可暴露给 Pi ResourceLoader 的 baseDir 与 SKILL.md 路径；不可读时返回 null。
 */
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
