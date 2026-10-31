import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const announcementPollsMigration: DatabaseMigration = {
  id: '0100_announcement_polls',
  description: 'Add account-scoped single-choice polls to popup announcements',
  async up(client) {
    await client.query(`
      CREATE TABLE announcement_polls (
        announcement_id uuid PRIMARY KEY REFERENCES popup_announcements(id) ON DELETE CASCADE,
        question text NOT NULL CHECK (char_length(btrim(question)) BETWEEN 1 AND 200),
        closes_at timestamptz,
        is_closed boolean NOT NULL DEFAULT false
      );
      CREATE TABLE announcement_poll_options (
        announcement_id uuid NOT NULL REFERENCES announcement_polls(announcement_id) ON DELETE CASCADE,
        id uuid NOT NULL,
        label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
        position smallint NOT NULL CHECK (position BETWEEN 0 AND 9),
        PRIMARY KEY (announcement_id, id),
        UNIQUE (announcement_id, position),
        UNIQUE (announcement_id, label)
      );
      CREATE TABLE announcement_poll_votes (
        announcement_id uuid NOT NULL,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        option_id uuid NOT NULL,
        PRIMARY KEY (announcement_id, user_id),
        FOREIGN KEY (announcement_id, option_id)
          REFERENCES announcement_poll_options(announcement_id, id) ON DELETE CASCADE
      );
      CREATE INDEX idx_announcement_poll_votes_option
        ON announcement_poll_votes(announcement_id, option_id);
      CREATE INDEX idx_announcement_poll_votes_user
        ON announcement_poll_votes(user_id);
    `);
  },
};
