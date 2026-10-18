import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const durableAgentRequestsMigration: DatabaseMigration = {
  id: '0076_durable_agent_requests',
  description: 'Persist agent admission, execution and result delivery',
  async up(client) {
    await client.query(`
      CREATE TABLE agent_requests (
        request_id text PRIMARY KEY,
        execution_id text NOT NULL,
        account_id text NOT NULL,
        session_id text NOT NULL,
        user_message_id text,
        owner_user_id text NOT NULL,
        state text NOT NULL CHECK (state IN ('queued','dispatched','running','result_ready','interrupted','completed')),
        input jsonb NOT NULL,
        runtime jsonb NOT NULL,
        lease_owner text,
        lease_until timestamptz,
        deadline_at timestamptz NOT NULL,
        cancel_requested_at timestamptz,
        result jsonb,
        interrupted_notified_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (NOT (runtime ? 'apiKey') AND NOT (runtime ? 'secret'))
      );
      CREATE INDEX agent_requests_recovery ON agent_requests (lease_until, created_at)
        WHERE state <> 'completed';
      CREATE UNIQUE INDEX agent_requests_session_writer ON agent_requests (session_id)
        WHERE state = 'running';
      CREATE TABLE agent_result_deliveries (
        request_id text PRIMARY KEY,
        account_id text NOT NULL,
        delivered boolean NOT NULL DEFAULT false,
        final_message_id text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  },
};
