import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const dropRedemptionCodesMigration: DatabaseMigration = {
  id: '0080_drop_redemption_codes',
  description: 'Drop the retired redemption code table',
  async up(client) {
    await client.query('DROP TABLE IF EXISTS public.redemption_codes');
  },
};
