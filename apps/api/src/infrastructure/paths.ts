/**
 * 运行时路径辅助。
 */

import fs from 'fs';

import { seedOfficialSkills } from './db.js';
import { logger } from './logger.js';
import { loadOfficialSkillCatalog } from '../modules/skills/skill-manifest.js';
import { resolveOfficialSkillsDir } from './official-skills-path.js';

/**
 * 扫描 skills/official/ 目录，将官方 Skill 名称写入 skill_global_config 表。
 * 使用 ON CONFLICT DO NOTHING，已有条目不会被覆盖。
 * 在服务启动时调用，确保新增官方 Skill 自动入库且默认开启。
 */
export async function seedOfficialSkillsFromDir(): Promise<void> {
  const officialDir = resolveOfficialSkillsDir();
  if (!fs.existsSync(officialDir)) return;

  const names = loadOfficialSkillCatalog(officialDir).map(
    (skill) => skill.name,
  );

  await seedOfficialSkills(names);
  logger.info({ count: names.length }, '官方 Skill 已同步到数据库');
}
