import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const issueReadMarkersMigration: DatabaseMigration = {
  id: '0099_issue_read_markers',
  description:
    'Track the newest issue timeline entry each participant has seen',
  async up(client) {
    // Existing history counts as seen so the release does not flag every past official action.
    await client.query(`
      ALTER TABLE issue_participants
        ADD COLUMN read_entry_id integer NOT NULL DEFAULT 0 CHECK (read_entry_id>=0);
      UPDATE issue_participants p SET read_entry_id=latest.id
        FROM (SELECT issue_id,max(id) AS id FROM issue_entries GROUP BY issue_id) latest
        WHERE latest.issue_id=p.issue_id;
    `);
  },
};
