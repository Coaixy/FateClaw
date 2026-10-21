import type { DatabaseMigration } from '#infrastructure/migrations/types';

export const runtimeConfigMigration: DatabaseMigration = {
  id: '0098_runtime_config',
  description:
    'Restore admin-owned runtime policies and retire obsolete settings',
  async up(client) {
    await client.query(`
      ALTER TABLE runtime_config
        ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
        ADD COLUMN wechat_claw_enabled boolean NOT NULL DEFAULT false,
        ADD CONSTRAINT runtime_config_account_concurrency_range
          CHECK (agent_account_concurrency BETWEEN 1 AND 100) NOT VALID,
        ADD CONSTRAINT runtime_config_global_concurrency_range
          CHECK (agent_concurrency_limit BETWEEN 1 AND 1000) NOT VALID,
        DROP COLUMN default_official_model_id,
        DROP COLUMN default_thinking_level,
        DROP COLUMN agent_request_timeout_ms;
      UPDATE runtime_config SET
        agent_account_concurrency=GREATEST(1,LEAST(100,agent_account_concurrency)),
        agent_concurrency_limit=GREATEST(1,LEAST(1000,agent_concurrency_limit));
      ALTER TABLE runtime_config
        VALIDATE CONSTRAINT runtime_config_account_concurrency_range,
        VALIDATE CONSTRAINT runtime_config_global_concurrency_range;
      INSERT INTO runtime_config(id) VALUES ('default') ON CONFLICT (id) DO NOTHING;
    `);
    // These LIST queues have no current writer; migration ownership avoids a startup write forever.
    await client.query(`
      CREATE TABLE runtime_upgrade_tasks (
        task_key text PRIMARY KEY,
        completed_at timestamptz
      );
      INSERT INTO runtime_upgrade_tasks(task_key) VALUES ('legacy_concurrency_wait_lists');
    `);
  },
};
