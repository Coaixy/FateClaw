import type { DatabaseMigration } from './types.js';
import { baselineMigrations } from './definitions/0001-core-baseline.js';
import { agentRuntimeAndBillingPerfMigrations } from './definitions/0070-agent-runtime-and-billing-perf.js';
import { cleanupInvalidPhoneUsersMigrations } from './definitions/0071-cleanup-invalid-phone-users.js';
import { purgeOrphanBundleSubscriptionsMigrations } from './definitions/0072-purge-orphan-bundle-subscriptions.js';
import { dropDeadFeatureTablesMigrations } from './definitions/0073-drop-dead-feature-tables.js';
import { dropRemovedFeatureTablesMigrations } from './definitions/0074-drop-removed-feature-tables.js';

/**
 * FateClaw 数据库迁移清单。
 *
 * @remarks
 * 历史 0001-0067 共 67 条迁移已压平为单一基线 {@link baselineMigrations}（见该文件说明，
 * 基线产出经逐行比对验证与原迁移完全等价）。基线之后从 0070 续号（跳过 0002-0069，因远程
 * ledger 已有这些历史编号）。今后新增迁移一律在本数组末尾追加新文件并展开，
 * 不要改写基线、重排顺序或复用已发布 id。
 */
export const MIGRATIONS: readonly DatabaseMigration[] = [
  ...baselineMigrations,
  ...agentRuntimeAndBillingPerfMigrations,
  ...cleanupInvalidPhoneUsersMigrations,
  ...purgeOrphanBundleSubscriptionsMigrations,
  ...dropDeadFeatureTablesMigrations,
  ...dropRemovedFeatureTablesMigrations,
];
