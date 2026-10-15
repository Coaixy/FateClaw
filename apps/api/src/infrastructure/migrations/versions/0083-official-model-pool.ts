import type { DatabaseMigration } from '../types.js';

export const officialModelPoolMigration: DatabaseMigration = {
  id: '0083_official_model_pool',
  description: 'Add official model pool configuration and shared circuit state',
  async up(client) {
    await client.query(`
      CREATE TABLE official_model_pool_settings (
        id text PRIMARY KEY CHECK (id = 'default'),
        public_model_id text NOT NULL,
        model_key text NOT NULL,
        display_name text NOT NULL,
        thinking_level text NOT NULL DEFAULT 'medium',
        input_token_price_per_million_coins integer NOT NULL DEFAULT 0 CHECK (input_token_price_per_million_coins >= 0),
        output_token_price_per_million_coins integer NOT NULL DEFAULT 0 CHECK (output_token_price_per_million_coins >= 0),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE official_model_pool_nodes (
        model_config_id text PRIMARY KEY REFERENCES official_model_configs(id),
        weight integer NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 1000),
        revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
        failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
        health_generation integer NOT NULL DEFAULT 0,
        cooldown_until timestamptz,
        probe_token text,
        probe_until timestamptz
      );
      WITH settings AS (
        SELECT default_official_model_id, default_thinking_level, updated_at
        FROM runtime_config WHERE id = 'default'
        UNION ALL SELECT NULL, 'medium', TIMESTAMPTZ '2026-10-15 00:00:00+00'
        WHERE NOT EXISTS (SELECT 1 FROM runtime_config WHERE id = 'default')
      ), current_model AS (
        SELECT model.* FROM settings
        JOIN LATERAL (
          SELECT * FROM official_model_configs
          WHERE settings.default_official_model_id IS NULL OR id = settings.default_official_model_id
          ORDER BY enabled DESC, priority ASC, created_at ASC, id ASC LIMIT 1
        ) model ON true
      ), enrolled AS (
        INSERT INTO official_model_pool_nodes (model_config_id)
        SELECT id FROM current_model RETURNING model_config_id
      )
      INSERT INTO official_model_pool_settings (
        id, public_model_id, model_key, display_name, thinking_level,
        input_token_price_per_million_coins, output_token_price_per_million_coins, updated_at
      )
      SELECT 'default', COALESCE(model.id, 'official-model-pool'),
        COALESCE(model.model_key, 'official'), COALESCE(model.display_name, '官方模型池'),
        settings.default_thinking_level,
        COALESCE(model.input_token_price_per_million_coins, 0),
        COALESCE(model.output_token_price_per_million_coins, 0),
        COALESCE(model.updated_at, settings.updated_at)
      FROM settings LEFT JOIN current_model model ON true
    `);
  },
};
