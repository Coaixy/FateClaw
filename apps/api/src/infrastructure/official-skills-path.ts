import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const OFFICIAL_SKILLS_RELATIVE_PATH = path.join('skills', 'official');

function findExistingFileFrom(
  startDir: string,
  fileName: string,
): string | null {
  let current = path.resolve(startDir);

  while (true) {
    const candidate = path.join(current, fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function readEnvValue(filePath: string, key: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    if (trimmed.slice(0, eqIdx).trim() !== key) continue;

    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value || undefined;
  }
  return undefined;
}

function readConfiguredOfficialSkillsDir(args: {
  cwd: string;
  moduleDir: string;
}): string | undefined {
  if (process.env.SKILLS_DIR) {
    return process.env.SKILLS_DIR;
  }

  const cwdEnvFile = findExistingFileFrom(args.cwd, '.env');
  if (cwdEnvFile) {
    const value = readEnvValue(cwdEnvFile, 'SKILLS_DIR');
    if (value) return value;
  }

  const moduleEnvFile = findExistingFileFrom(args.moduleDir, '.env');
  return moduleEnvFile ? readEnvValue(moduleEnvFile, 'SKILLS_DIR') : undefined;
}

function findExistingOfficialSkillsDirFrom(startDir: string): string | null {
  let current = path.resolve(startDir);

  while (true) {
    const candidate = path.join(current, OFFICIAL_SKILLS_RELATIVE_PATH);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * 解析官方 Skill 根目录。
 *
 * Windows 服务部署时，进程 cwd 可能是 apps/api、PM2/服务管理器目录，
 * 甚至是任意启动目录；只用 process.cwd() 会把脚本误判为不存在。
 * 因此优先尊重显式 SKILLS_DIR，其次从当前模块位置向上寻找仓库根目录。
 */
export function resolveOfficialSkillsDir(options?: {
  cwd?: string;
  moduleDir?: string;
  envSkillsDir?: string;
}): string {
  const cwd = options?.cwd ?? process.cwd();
  const moduleDir = options?.moduleDir ?? MODULE_DIR;
  const configured =
    options?.envSkillsDir?.trim() ||
    readConfiguredOfficialSkillsDir({ cwd, moduleDir });
  if (configured?.trim()) {
    return path.resolve(configured.trim());
  }

  const cwdCandidate = path.resolve(cwd, OFFICIAL_SKILLS_RELATIVE_PATH);
  if (fs.existsSync(cwdCandidate)) {
    return cwdCandidate;
  }

  const moduleCandidate = findExistingOfficialSkillsDirFrom(moduleDir);
  if (moduleCandidate) {
    return moduleCandidate;
  }

  // 保留旧路径作为最后回退，便于部署缺文件时仍暴露清晰的原始错误。
  return cwdCandidate;
}
