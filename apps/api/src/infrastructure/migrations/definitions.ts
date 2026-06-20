import type { DatabaseMigration } from './types.js';
import { initialSchemaMigrations } from './definitions/0001-0002-core.js';
import { applicationSchemaMigrations } from './definitions/0003-application.js';
import { userBillingMigrations } from './definitions/0004-0011-user-billing.js';
import { financeArchiveMigrations } from './definitions/0012-0019-finance-archive.js';
import { runtimeSkillMigrations } from './definitions/0020-0028-runtime-skills.js';
import { sqlReviewFixMigrations } from './definitions/0045-sql-review-fixes.js';
import { guashiAccessMigrations } from './definitions/0049-guashi-access.js';
import { clientProfilesMigrations } from './definitions/0050-client-profiles.js';
import { guashiScriptTemplateMigrations } from './definitions/0051-guashi-script-template.js';
import { disableLegacyPlusProMigrations } from './definitions/0052-disable-legacy-plus-pro.js';
import { clarityNoAllowanceMigrations } from './definitions/0053-clarity-no-allowance.js';
import { migrateLegacyMembersToClarityMigrations } from './definitions/0054-migrate-legacy-members-to-clarity.js';
import { allowanceUnitsNonnegativeMigrations } from './definitions/0055-allowance-units-nonnegative.js';
import { referralRewardClarityMigrations } from './definitions/0056-referral-reward-clarity.js';
import { disableWechatAccountsMigrations } from './definitions/0057-disable-wechat-claw-accounts.js';
import { normalizeAllPlanKeysToClarityMigrations } from './definitions/0058-normalize-all-plan-keys-to-clarity.js';
import { dropAllowanceColumnsAndTableMigrations } from './definitions/0059-drop-allowance-columns-and-table.js';
import { clientCrmFieldsMigrations } from './definitions/0060-client-crm-fields.js';

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
  ...sqlReviewFixMigrations,
  ...guashiAccessMigrations,
  ...clientProfilesMigrations,
  ...guashiScriptTemplateMigrations,
  ...disableLegacyPlusProMigrations,
  ...clarityNoAllowanceMigrations,
  ...migrateLegacyMembersToClarityMigrations,
  ...allowanceUnitsNonnegativeMigrations,
  ...referralRewardClarityMigrations,
  ...disableWechatAccountsMigrations,
  ...normalizeAllPlanKeysToClarityMigrations,
  ...dropAllowanceColumnsAndTableMigrations,
  ...clientCrmFieldsMigrations,
];
