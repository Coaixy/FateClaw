import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const serviceNetworkStatusMigration: DatabaseMigration = {
  id: '0102_service_network_status',
  description: 'Start independent network probes for the public status page',
  async up(client) {
    await client.query(`
      ALTER TABLE ai_service_status_checks
        ADD COLUMN probe_kind text NOT NULL DEFAULT 'inference'
        CHECK (probe_kind IN ('inference', 'http_head'));
      ALTER TABLE ai_service_status_schedule
        DROP CONSTRAINT ai_service_status_schedule_id_check;
      ALTER TABLE ai_service_status_schedule
        ADD CONSTRAINT ai_service_status_schedule_id_check
        CHECK (id IN ('ai', 'benefit', 'network-official', 'network-benefit'));
      INSERT INTO ai_service_status_schedule (id)
        VALUES ('network-official'), ('network-benefit');
    `);
  },
};
