import type { DatabaseBaseline, DatabaseMigration } from './types.js';
import { currentSchemaBaseline } from './baselines/0077-current-schema.js';
import { legacySchemaMigration } from './versions/0001-core-baseline.js';
import { agentRuntimeAndBillingPerfMigration } from './versions/0070-agent-runtime-and-billing-perf.js';
import { cleanupInvalidPhoneUsersMigration } from './versions/0071-cleanup-invalid-phone-users.js';
import { purgeOrphanBundleSubscriptionsMigration } from './versions/0072-purge-orphan-bundle-subscriptions.js';
import { dropDeadFeatureTablesMigration } from './versions/0073-drop-dead-feature-tables.js';
import { dropRemovedFeatureTablesMigration } from './versions/0074-drop-removed-feature-tables.js';
import { addRedemptionCodesMigration } from './versions/0075-add-redemption-codes.js';
import { durableAgentRequestsMigration } from './versions/0076-durable-agent-requests.js';
import { dropBaziCasesMigration } from './versions/0077-drop-bazi-cases.js';
import { dropPublicFinancialLedgerMigration } from './versions/0078-drop-public-financial-ledger.js';
import { dropAnnouncementsMigration } from './versions/0079-drop-announcements.js';
import { dropRedemptionCodesMigration } from './versions/0080-drop-redemption-codes.js';
import { skillContentRevisionsMigration } from './versions/0081-skill-content-revisions.js';
import { unifyMembershipIdentityMigration } from './versions/0082-unify-membership-identity.js';
import { officialModelPoolMigration } from './versions/0083-official-model-pool.js';
import { officialModelPoolPrimaryMigration } from './versions/0084-official-model-pool-primary.js';
import { aiServiceStatusMigration } from './versions/0085-ai-service-status.js';
import { issuesMigration } from './versions/0086-issues.js';
import { benefitModelPoolMigration } from './versions/0087-benefit-model-pool.js';
import { benefitUserDeletionMigration } from './versions/0088-benefit-user-deletion.js';
import { benefitNodeCooldownMigration } from './versions/0089-benefit-node-cooldown.js';
import { benefitTurnsAndConcurrencyMigration } from './versions/0090-benefit-turns-and-concurrency.js';

// IDs and order are part of the upgrade contract for existing databases.
export const MIGRATIONS: readonly DatabaseMigration[] = [
  legacySchemaMigration,
  agentRuntimeAndBillingPerfMigration,
  cleanupInvalidPhoneUsersMigration,
  purgeOrphanBundleSubscriptionsMigration,
  dropDeadFeatureTablesMigration,
  dropRemovedFeatureTablesMigration,
  addRedemptionCodesMigration,
  durableAgentRequestsMigration,
  dropBaziCasesMigration,
  dropPublicFinancialLedgerMigration,
  dropAnnouncementsMigration,
  dropRedemptionCodesMigration,
  skillContentRevisionsMigration,
  unifyMembershipIdentityMigration,
  officialModelPoolMigration,
  officialModelPoolPrimaryMigration,
  aiServiceStatusMigration,
  issuesMigration,
  benefitModelPoolMigration,
  benefitUserDeletionMigration,
  benefitNodeCooldownMigration,
  benefitTurnsAndConcurrencyMigration,
];

export const BASELINES: readonly DatabaseBaseline[] = [currentSchemaBaseline];

export function validateMigrationManifest(
  migrations: readonly DatabaseMigration[],
  baselines: readonly DatabaseBaseline[],
): void {
  const ids = new Set<string>();
  let previousId = '';
  for (const migration of migrations) {
    if (ids.has(migration.id)) {
      throw new Error(`Duplicate database migration ID: ${migration.id}`);
    }
    if (migration.id <= previousId) {
      throw new Error('Database migrations must remain in increasing ID order');
    }
    ids.add(migration.id);
    previousId = migration.id;
  }

  if (baselines.length === 0) {
    throw new Error('No database baseline registered');
  }
  let previousBoundary = -1;
  for (const baseline of baselines) {
    const boundary = migrations.findIndex(
      (migration) => migration.id === baseline.throughMigrationId,
    );
    if (boundary < 0) {
      throw new Error(
        `Unknown baseline migration boundary: ${baseline.throughMigrationId}`,
      );
    }
    if (boundary <= previousBoundary) {
      throw new Error(
        'Database baselines must have increasing migration boundaries',
      );
    }
    previousBoundary = boundary;
  }
}
