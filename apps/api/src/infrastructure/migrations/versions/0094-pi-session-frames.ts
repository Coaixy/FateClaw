import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const piSessionFramesMigration: DatabaseMigration = {
  id: '0094_pi_session_frames',
  description:
    'Persist incremental Pi sessions and periodic recovery checkpoints',
  async up(client) {
    await client.query(`
      CREATE TABLE pi_session_frames (
        request_id text PRIMARY KEY,
        session_id text NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        account_id text NOT NULL,
        base_request_id text REFERENCES pi_session_frames(request_id) ON DELETE CASCADE,
        messages_hash text NOT NULL,
        message_count integer NOT NULL CHECK (message_count >= 0),
        checkpoint_depth integer NOT NULL CHECK (checkpoint_depth BETWEEN 0 AND 15),
        frame jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK ((base_request_id IS NULL) = (checkpoint_depth = 0))
      );
      CREATE INDEX pi_session_frames_latest ON pi_session_frames(session_id, created_at DESC, request_id DESC);
    `);
  },
};
