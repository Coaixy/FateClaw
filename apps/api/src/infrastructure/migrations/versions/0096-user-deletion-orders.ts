import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const userDeletionOrdersMigration: DatabaseMigration = {
  id: '0096_user_deletion_orders',
  description:
    'Retain detached orders and reconcile payments after user deletion',
  async up(client) {
    await client.query(`
      ALTER TABLE recharge_orders DROP CONSTRAINT recharge_orders_user_id_fkey,
        ALTER COLUMN user_id DROP NOT NULL,
        ADD CONSTRAINT recharge_orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN credit_status text NOT NULL DEFAULT 'pending'
          CHECK (credit_status IN ('pending','credited','reconciliation_required'));
      UPDATE recharge_orders SET credit_status='credited' WHERE status='paid';
      ALTER TABLE skill_access_invites DROP CONSTRAINT skill_access_invites_creator_id_fkey,
        ADD CONSTRAINT skill_access_invites_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE;
    `);
  },
};
