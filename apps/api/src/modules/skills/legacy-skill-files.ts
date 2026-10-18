import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeSkillContentPath,
  SkillContentValidationError,
  type SkillContentFile,
} from '@fateclaw/contracts/skills/content';
import { resolveProjectRoot } from '#infrastructure/project-root';

function inside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

export function readLegacySkillFiles(bundleUri: string): SkillContentFile[] {
  if (!bundleUri || bundleUri.startsWith('db://')) return [];
  const absolute = path.resolve(
    bundleUri.startsWith('file://') ? fileURLToPath(bundleUri) : bundleUri,
  );
  const normalized = absolute.replace(/\\/g, '/');
  const marker = '/.fateclaw/text-skills/';
  const suffix = normalized.includes(marker)
    ? normalized.slice(normalized.indexOf(marker) + marker.length)
    : null;
  const candidates = [
    ...new Set([
      absolute,
      ...[
        process.env.FATECLAW_TEXT_SKILLS_DIR,
        path.join(resolveProjectRoot(), '.fateclaw/text-skills'),
      ]
        .filter((root): root is string => Boolean(root && suffix))
        .map((root) => path.resolve(root, suffix!)),
    ]),
  ];
  for (const directory of candidates) {
    const home = process.env.HOME;
    if (
      (home &&
        [
          path.join(home, '.pi/skills'),
          path.join(home, '.pi/agent/skills'),
        ].some((root) => inside(directory, root))) ||
      /[\\/]\.pi[\\/](?:agent[\\/])?skills(?:[\\/]|$)/.test(directory)
    ) {
      throw new SkillContentValidationError(
        '私有 Skill 不能从 Pi 全局目录导入',
      );
    }
    const files: SkillContentFile[] = [];
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (
          entry.name.startsWith('.') ||
          [
            '__MACOSX',
            '__pycache__',
            'node_modules',
            'dist',
            'build',
            'coverage',
          ].includes(entry.name)
        )
          continue;
        const target = path.join(current, entry.name);
        if (entry.isDirectory()) walk(target);
        else if (entry.isFile()) {
          const relative = path
            .relative(directory, target)
            .split(path.sep)
            .join('/');
          // Only files accepted by the legacy text format were part of its stored checksum.
          let safe: string;
          try {
            safe = normalizeSkillContentPath(relative);
          } catch (err) {
            if (!(err instanceof SkillContentValidationError)) throw err;
            continue;
          }
          files.push({ path: safe, content: fs.readFileSync(target, 'utf8') });
        }
      }
    };
    try {
      walk(directory);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if (files.some((file) => file.path === 'SKILL.md')) return files;
  }
  return [];
}
