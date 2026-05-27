import fs from 'fs';
import path from 'path';

const OFFICIAL_SCRIPT_DEPENDENCY_PACKAGES = [
  'bazi-ts-lib',
  'iching-shifa',
  'iztro',
  'kinqimen',
] as const;

function resolveScriptNodeModulesDir(skillsDir: string): string {
  return path.resolve(skillsDir, '..', 'node_modules');
}

function resolveFallbackNodeModulesDirs(skillsDir: string): string[] {
  const projectRoot = path.resolve(skillsDir, '..', '..');
  return [
    path.join(projectRoot, 'apps', 'api', 'node_modules'),
    path.join(projectRoot, 'packages', 'agent-runner', 'node_modules'),
  ];
}

/**
 * 确保官方排盘脚本能解析到自身运行时依赖。
 *
 * 正常形态下这些依赖应安装在 `skills/node_modules`。
 * 为兼容旧部署（依赖仍落在 apps/api/node_modules），这里会按需补齐符号链接。
 */
export function ensureOfficialScriptDependenciesAccessible(
  skillsDir: string,
): void {
  const skillNodeModulesDir = resolveScriptNodeModulesDir(skillsDir);
  const fallbackDirs = resolveFallbackNodeModulesDirs(skillsDir).filter((dir) =>
    fs.existsSync(dir),
  );

  if (fallbackDirs.length === 0) {
    return;
  }

  fs.mkdirSync(skillNodeModulesDir, { recursive: true });

  for (const packageName of OFFICIAL_SCRIPT_DEPENDENCY_PACKAGES) {
    const targetPath = path.join(skillNodeModulesDir, packageName);
    if (fs.existsSync(targetPath)) {
      continue;
    }

    const sourcePath = fallbackDirs
      .map((dir) => path.join(dir, packageName))
      .find((candidate) => fs.existsSync(candidate));
    if (!sourcePath) {
      continue;
    }

    fs.symlinkSync(
      sourcePath,
      targetPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
}
