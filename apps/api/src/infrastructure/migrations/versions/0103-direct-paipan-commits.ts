import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const directPaipanCommitsMigration: DatabaseMigration = {
  id: '0103_direct_paipan_commits',
  description: 'Persist idempotent direct chart preview submissions',
  async up(client) {
    await client.query(`
      CREATE TABLE direct_paipan_commits (
        preview_id uuid PRIMARY KEY,
        user_id text REFERENCES users(id) ON DELETE SET NULL,
        session_id text UNIQUE REFERENCES chat_sessions(id) ON DELETE SET NULL
          DEFERRABLE INITIALLY DEFERRED,
        request_message_id text NOT NULL,
        result_message_id text NOT NULL
      );
      CREATE INDEX direct_paipan_commits_user_id_idx
        ON direct_paipan_commits (user_id) WHERE user_id IS NOT NULL;
    `);
  },
};
