import type { DatabaseMigration } from './types.js';
import { initialSchemaMigrations } from './definitions/0001-0002-core.js';
import { applicationSchemaMigrations } from './definitions/0003-application.js';
import { userBillingMigrations } from './definitions/0004-0011-user-billing.js';
import { financeArchiveMigrations } from './definitions/0012-0019-finance-archive.js';
import { runtimeSkillMigrations } from './definitions/0020-0028-runtime-skills.js';

/**
 * FateClaw 数据库迁移清单。
 *
 * @remarks 只在分段文件末尾追加新迁移；不要重排、改写或删除已发布迁移。
 */
export const MIGRATIONS: readonly DatabaseMigration[] = [
  ...initialSchemaMigrations,
  ...applicationSchemaMigrations,
  ...userBillingMigrations,
  ...financeArchiveMigrations,
  ...runtimeSkillMigrations,
];
