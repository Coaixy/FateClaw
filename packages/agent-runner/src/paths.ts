/**
 * 集中管理 agent-runner 的工作目录路径。
 */
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
 * 解析官方 Skill 目录。
 * Windows 服务部署时 cwd 不稳定，agent-runner 不能只依赖宿主启动目录。
 */
export function resolveAgentSkillsDir(options?: {
  cwd?: string;
  moduleDir?: string;
  envSkillsDir?: string;
}): string {
  const configured = options?.envSkillsDir?.trim() || process.env.SKILLS_DIR;
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

  return cwdCandidate;
}

export const SKILLS_DIR = resolveAgentSkillsDir();
