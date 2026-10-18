/**
 * 启动期注册表同步辅助。
 */

import { seedOfficialSkills } from './db.js';
import { logger } from './logger.js';
import { listPaipanRegistry } from '#modules/chat/paipan-registry';

/**
 * 将系统排盘名称写入 skill_global_config 表。
 * 使用 ON CONFLICT DO NOTHING，已有条目不会被覆盖。
 * 在服务启动时调用，确保新增系统排盘自动入库且默认开启。
 */
export async function seedOfficialSkillsFromRegistry(): Promise<void> {
  const names = listPaipanRegistry().map((board) => board.name);

  await seedOfficialSkills(names);
  logger.info({ count: names.length }, '系统排盘开关已同步到数据库');
}
