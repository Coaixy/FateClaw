import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const dropBaziCasesMigration: DatabaseMigration = {
  id: '0077_drop_bazi_cases',
  description: 'Drop the retired Bazi case dataset',
  async up(client) {
    await client.query('DROP TABLE IF EXISTS public.bazi_cases');
  },
};
