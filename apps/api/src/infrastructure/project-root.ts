import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function hasProjectRootMarkers(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, 'package.json')) &&
    fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))
  );
}

function findProjectRootFrom(startDir: string): string | null {
  let current = path.resolve(startDir);

  while (true) {
    if (hasProjectRootMarkers(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * 解析仓库根目录。
 * Windows 服务的工作目录可能不是仓库根，因此运行时资源不要只依赖 process.cwd()。
 */
export function resolveProjectRoot(options?: {
  cwd?: string;
  moduleDir?: string;
}): string {
  const cwd = options?.cwd ?? process.cwd();
  const cwdRoot = findProjectRootFrom(cwd);
  if (cwdRoot) {
    return cwdRoot;
  }

  const moduleDir = options?.moduleDir ?? MODULE_DIR;
  const moduleRoot = findProjectRootFrom(moduleDir);
  if (moduleRoot) {
    return moduleRoot;
  }

  return path.resolve(cwd);
}
