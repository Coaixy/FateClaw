import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const OFFICIAL_SKILLS_RELATIVE_PATH = path.join('skills', 'official');

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
  const configured = options?.envSkillsDir ?? process.env.SKILLS_DIR;
  if (configured?.trim()) {
    return path.resolve(configured.trim());
  }

  const cwd = options?.cwd ?? process.cwd();
  const cwdCandidate = path.resolve(cwd, OFFICIAL_SKILLS_RELATIVE_PATH);
  if (fs.existsSync(cwdCandidate)) {
    return cwdCandidate;
  }

  const moduleDir = options?.moduleDir ?? MODULE_DIR;
  const moduleCandidate = findExistingOfficialSkillsDirFrom(moduleDir);
  if (moduleCandidate) {
    return moduleCandidate;
  }

  // 保留旧路径作为最后回退，便于部署缺文件时仍暴露清晰的原始错误。
  return cwdCandidate;
}
