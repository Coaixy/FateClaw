import type { DatabaseBaseline, DatabaseMigration } from './types.js';
import { currentSchemaBaseline } from '#infrastructure/migrations/baselines/0077-current-schema';
import { legacySchemaMigration } from '#infrastructure/migrations/versions/0001-core-baseline';
import { agentRuntimeAndBillingPerfMigration } from '#infrastructure/migrations/versions/0070-agent-runtime-and-billing-perf';
import { cleanupInvalidPhoneUsersMigration } from '#infrastructure/migrations/versions/0071-cleanup-invalid-phone-users';
import { purgeOrphanBundleSubscriptionsMigration } from '#infrastructure/migrations/versions/0072-purge-orphan-bundle-subscriptions';
import { dropDeadFeatureTablesMigration } from '#infrastructure/migrations/versions/0073-drop-dead-feature-tables';
import { dropRemovedFeatureTablesMigration } from '#infrastructure/migrations/versions/0074-drop-removed-feature-tables';
import { addRedemptionCodesMigration } from '#infrastructure/migrations/versions/0075-add-redemption-codes';
import { durableAgentRequestsMigration } from '#infrastructure/migrations/versions/0076-durable-agent-requests';
import { dropBaziCasesMigration } from '#infrastructure/migrations/versions/0077-drop-bazi-cases';
import { dropPublicFinancialLedgerMigration } from '#infrastructure/migrations/versions/0078-drop-public-financial-ledger';
import { dropAnnouncementsMigration } from '#infrastructure/migrations/versions/0079-drop-announcements';
import { dropRedemptionCodesMigration } from '#infrastructure/migrations/versions/0080-drop-redemption-codes';
import { skillContentRevisionsMigration } from '#infrastructure/migrations/versions/0081-skill-content-revisions';
import { unifyMembershipIdentityMigration } from '#infrastructure/migrations/versions/0082-unify-membership-identity';
import { officialModelPoolMigration } from '#infrastructure/migrations/versions/0083-official-model-pool';
import { officialModelPoolPrimaryMigration } from '#infrastructure/migrations/versions/0084-official-model-pool-primary';
import { aiServiceStatusMigration } from '#infrastructure/migrations/versions/0085-ai-service-status';
import { issuesMigration } from '#infrastructure/migrations/versions/0086-issues';
import { benefitModelPoolMigration } from '#infrastructure/migrations/versions/0087-benefit-model-pool';
import { benefitUserDeletionMigration } from '#infrastructure/migrations/versions/0088-benefit-user-deletion';
import { benefitNodeCooldownMigration } from '#infrastructure/migrations/versions/0089-benefit-node-cooldown';
import { benefitTurnsAndConcurrencyMigration } from '#infrastructure/migrations/versions/0090-benefit-turns-and-concurrency';
import { popupAnnouncementsMigration } from '#infrastructure/migrations/versions/0091-popup-announcements';
import { registrationInvitesMigration } from '#infrastructure/migrations/versions/0092-registration-invites';
import { registrationInviteTiersMigration } from '#infrastructure/migrations/versions/0093-registration-invite-tiers';
import { piSessionFramesMigration } from '#infrastructure/migrations/versions/0094-pi-session-frames';
import { benefitFailureBudgetMigration } from '#infrastructure/migrations/versions/0095-benefit-failure-budget';
import { userDeletionOrdersMigration } from '#infrastructure/migrations/versions/0096-user-deletion-orders';
import { runtimeIpcReceiptsMigration } from '#infrastructure/migrations/versions/0097-runtime-ipc-receipts';
import { runtimeConfigMigration } from '#infrastructure/migrations/versions/0098-runtime-config';

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
  popupAnnouncementsMigration,
  registrationInvitesMigration,
  registrationInviteTiersMigration,
  piSessionFramesMigration,
  benefitFailureBudgetMigration,
  userDeletionOrdersMigration,
  runtimeIpcReceiptsMigration,
  runtimeConfigMigration,
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
