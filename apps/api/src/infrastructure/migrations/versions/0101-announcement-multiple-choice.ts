import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const announcementMultipleChoiceMigration: DatabaseMigration = {
  id: '0101_announcement_multiple_choice',
  description: 'Support multiple selections per account in announcement polls',
  async up(client) {
    await client.query(`
      ALTER TABLE announcement_polls
        ADD COLUMN allow_multiple boolean NOT NULL DEFAULT false;
      ALTER TABLE announcement_poll_votes
        DROP CONSTRAINT announcement_poll_votes_pkey,
        ADD PRIMARY KEY (announcement_id, user_id, option_id);
    `);
  },
};
