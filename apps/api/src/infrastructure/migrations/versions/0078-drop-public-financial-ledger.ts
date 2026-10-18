import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const dropPublicFinancialLedgerMigration: DatabaseMigration = {
  id: '0078_drop_public_financial_ledger',
  description: 'Drop the retired public financial ledger',
  async up(client) {
    await client.query(
      'DROP TABLE IF EXISTS public.public_financial_ledger_entries',
    );
  },
};
