import type { DatabaseMigration } from '../types.js';

export const officialModelPoolPrimaryMigration: DatabaseMigration = {
  id: '0084_official_model_pool_primary',
  description: 'Retain one designated primary node in the official model pool',
  async up(client) {
    await client.query(`
      ALTER TABLE official_model_pool_settings
        ADD COLUMN primary_node_id text
          REFERENCES official_model_pool_nodes(model_config_id) ON DELETE RESTRICT;
      UPDATE official_model_pool_settings pool SET primary_node_id = (
        SELECT node.model_config_id
        FROM official_model_pool_nodes node
        JOIN official_model_configs model ON model.id = node.model_config_id
        ORDER BY (model.id = pool.public_model_id) DESC, model.created_at, model.id
        LIMIT 1
      )
    `);
  },
};
