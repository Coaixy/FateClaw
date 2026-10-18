import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const popupAnnouncementsMigration: DatabaseMigration = {
  id: '0091_popup_announcements',
  description: 'Add versioned popup announcements managed by site owners',
  async up(client) {
    await client.query(`
      CREATE TABLE popup_announcements (
        id uuid PRIMARY KEY,
        title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
        body_markdown text NOT NULL CHECK (char_length(btrim(body_markdown)) BETWEEN 1 AND 20000),
        status text NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
        revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
        published_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK (status <> 'published' OR published_at IS NOT NULL)
      );
      CREATE INDEX idx_popup_announcements_updated
        ON popup_announcements (updated_at DESC, id);
      CREATE INDEX idx_popup_announcements_published
        ON popup_announcements (published_at DESC, id) WHERE status = 'published';
    `);
  },
};
