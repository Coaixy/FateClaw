import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const aiServiceStatusMigration: DatabaseMigration = {
  id: '0085_ai_service_status',
  description: 'Persist shared low-frequency AI availability checks',
  async up(client) {
    await client.query(`
      CREATE TABLE ai_service_status_schedule (
        id text PRIMARY KEY CHECK (id='ai'),
        next_check_at timestamptz NOT NULL DEFAULT '2000-01-01T00:00:00Z',
        lease_token text,
        lease_until timestamptz
      );
      INSERT INTO ai_service_status_schedule (id) VALUES ('ai');
      CREATE TABLE ai_service_status_checks (
        checked_at timestamptz PRIMARY KEY,
        status text NOT NULL CHECK (status IN ('operational','unavailable','unknown')),
        latency_ms integer,
        CHECK ((status='operational' AND latency_ms >= 0 AND latency_ms IS NOT NULL)
          OR (status<>'operational' AND latency_ms IS NULL))
      )
    `);
  },
};
