/**
 * 集中管理 agent-runner 的工作目录路径。
 */
import path from 'path';

const PROJECT_ROOT = process.cwd();

export const SKILLS_DIR = process.env.SKILLS_DIR
  || path.join(PROJECT_ROOT, 'skills', 'official');
