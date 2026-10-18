import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const dropAnnouncementsMigration: DatabaseMigration = {
  id: '0079_drop_announcements',
  description: 'Drop the retired announcements module table',
  async up(client) {
    await client.query('DROP TABLE IF EXISTS public.announcements');
  },
};
