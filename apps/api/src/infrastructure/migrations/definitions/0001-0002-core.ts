import type { DatabaseMigration } from '../types.js';
import { ensureCheckConstraint } from '../helpers.js';

/**
 * 数据库迁移分段：0001-0002。
 */
export const initialSchemaMigrations: readonly DatabaseMigration[] = [
  {
    id: '0001_core_schema_baseline',
    description: '创建历史 init-pg.sql 承载的核心基础表',
    async up(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          phone TEXT NOT NULL UNIQUE,
          phone_verified BOOLEAN NOT NULL DEFAULT true,
          password_hash TEXT NOT NULL,
          auth_token_version INTEGER NOT NULL DEFAULT 0,
          role TEXT NOT NULL DEFAULT 'consumer',
          purchased_cents INTEGER NOT NULL DEFAULT 0,
          bonus_cents INTEGER NOT NULL DEFAULT 0,
          earned_cents INTEGER NOT NULL DEFAULT 0,
          reserved_cents INTEGER NOT NULL DEFAULT 0,
          pending_withdrawal_cents INTEGER NOT NULL DEFAULT 0,
          soul_edit_enabled BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS daily_usage (
          user_id TEXT NOT NULL REFERENCES users(id),
          date TEXT NOT NULL,
          msg_count INTEGER DEFAULT 0,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          total_tokens INTEGER DEFAULT 0,
          PRIMARY KEY (user_id, date)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          bot_token TEXT NOT NULL,
          base_url TEXT NOT NULL,
          soul_content TEXT DEFAULT '',
          get_updates_buf TEXT DEFAULT '',
          enabled BOOLEAN DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL,
          owner_id TEXT REFERENCES users(id)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT,
          account_id TEXT NOT NULL,
          sender TEXT NOT NULL,
          sender_name TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp TIMESTAMPTZ NOT NULL,
          is_from_me BOOLEAN DEFAULT false,
          is_bot_message BOOLEAN DEFAULT false,
          deleted_at TIMESTAMPTZ DEFAULT NULL,
          tool_context TEXT DEFAULT NULL,
          session_id TEXT DEFAULT NULL,
          user_id TEXT DEFAULT NULL REFERENCES users(id),
          metadata JSONB DEFAULT NULL,
          PRIMARY KEY (id, account_id)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id)`,
      );
    },
  },
  {
    id: '0002_config_and_model_schema',
    description: '迁移系统密钥、模型配置与配置审计 schema',
    async up(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS skill_global_config (
          skill_name TEXT PRIMARY KEY,
          globally_enabled BOOLEAN NOT NULL DEFAULT true,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT DEFAULT NULL
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS system_secrets (
          key TEXT PRIMARY KEY,
          secret_value TEXT NOT NULL,
          updated_by TEXT DEFAULT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `ALTER TABLE system_secrets ADD COLUMN IF NOT EXISTS secret_value TEXT`,
      );
      await client.query(
        `UPDATE system_secrets SET secret_value = '' WHERE secret_value IS NULL`,
      );
      await client.query(
        `ALTER TABLE system_secrets ALTER COLUMN secret_value SET NOT NULL`,
      );
      await client.query(
        `ALTER TABLE system_secrets DROP COLUMN IF EXISTS ciphertext`,
      );
      await client.query(`ALTER TABLE system_secrets DROP COLUMN IF EXISTS iv`);
      await client.query(
        `ALTER TABLE system_secrets DROP COLUMN IF EXISTS auth_tag`,
      );
      await client.query(
        `ALTER TABLE system_secrets DROP COLUMN IF EXISTS version`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS official_model_configs (
          id TEXT PRIMARY KEY,
          model_key TEXT NOT NULL UNIQUE,
          pi_api TEXT NOT NULL,
          display_name TEXT NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT true,
          priority INTEGER NOT NULL DEFAULT 0,
          base_url TEXT DEFAULT NULL,
          model_name TEXT NOT NULL,
          api_key_secret_key TEXT DEFAULT NULL,
          input_token_price_per_million_cents INTEGER NOT NULL DEFAULT 0,
          output_token_price_per_million_cents INTEGER NOT NULL DEFAULT 0,
          extra_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_model_configs (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          pi_api TEXT NOT NULL,
          base_url TEXT DEFAULT NULL,
          model_name TEXT NOT NULL,
          api_key_secret_key TEXT DEFAULT NULL,
          extra_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_model_selections (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          source TEXT NOT NULL,
          official_model_id TEXT DEFAULT NULL REFERENCES official_model_configs(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS config_audit_logs (
          id TEXT PRIMARY KEY,
          actor_user_id TEXT DEFAULT NULL,
          action TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_key TEXT NOT NULL,
          before_json JSONB DEFAULT NULL,
          after_json JSONB DEFAULT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        ALTER TABLE official_model_configs
        DROP CONSTRAINT IF EXISTS chk_official_model_configs_pi_api_valid
      `);
      await client.query(`
        ALTER TABLE user_model_configs
        DROP CONSTRAINT IF EXISTS chk_user_model_configs_pi_api_valid
      `);
      await client.query(`
        ALTER TABLE official_model_configs
        DROP CONSTRAINT IF EXISTS chk_official_model_configs_protocol_valid
      `);
      await client.query(`
        ALTER TABLE user_model_configs
        DROP CONSTRAINT IF EXISTS chk_user_model_configs_protocol_valid
      `);
      await client.query(`
        ALTER TABLE official_model_configs
        ADD COLUMN IF NOT EXISTS pi_api TEXT
      `);
      await client.query(`
        ALTER TABLE user_model_configs
        ADD COLUMN IF NOT EXISTS pi_api TEXT
      `);
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'official_model_configs'
              AND column_name = 'protocol'
          ) THEN
            UPDATE official_model_configs
            SET pi_api = CASE
              WHEN COALESCE(pi_api, protocol) IN ('openai', 'openai_compatible', 'openai-compatible', 'openai-completions') THEN 'openai-completions'
              WHEN COALESCE(pi_api, protocol) IN ('openai-response', 'openai_responses', 'openai-responses') THEN 'openai-responses'
              WHEN COALESCE(pi_api, protocol) IN ('anthropic', 'anthropic-messages') THEN 'anthropic-messages'
              WHEN COALESCE(pi_api, protocol) IN ('gemini', 'google-generative-ai') THEN 'google-generative-ai'
              ELSE 'openai-completions'
            END;
          ELSE
            UPDATE official_model_configs
            SET pi_api = CASE
              WHEN pi_api IN ('openai', 'openai_compatible', 'openai-compatible', 'openai-completions') THEN 'openai-completions'
              WHEN pi_api IN ('openai-response', 'openai_responses', 'openai-responses') THEN 'openai-responses'
              WHEN pi_api IN ('anthropic', 'anthropic-messages') THEN 'anthropic-messages'
              WHEN pi_api IN ('gemini', 'google-generative-ai') THEN 'google-generative-ai'
              ELSE 'openai-completions'
            END;
          END IF;
        END $$;
      `);
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'user_model_configs'
              AND column_name = 'protocol'
          ) THEN
            UPDATE user_model_configs
            SET pi_api = CASE
              WHEN COALESCE(pi_api, protocol) IN ('openai', 'openai_compatible', 'openai-compatible', 'openai-completions') THEN 'openai-completions'
              WHEN COALESCE(pi_api, protocol) IN ('openai-response', 'openai_responses', 'openai-responses') THEN 'openai-responses'
              WHEN COALESCE(pi_api, protocol) IN ('anthropic', 'anthropic-messages') THEN 'anthropic-messages'
              WHEN COALESCE(pi_api, protocol) IN ('gemini', 'google-generative-ai') THEN 'google-generative-ai'
              ELSE 'openai-completions'
            END;
          ELSE
            UPDATE user_model_configs
            SET pi_api = CASE
              WHEN pi_api IN ('openai', 'openai_compatible', 'openai-compatible', 'openai-completions') THEN 'openai-completions'
              WHEN pi_api IN ('openai-response', 'openai_responses', 'openai-responses') THEN 'openai-responses'
              WHEN pi_api IN ('anthropic', 'anthropic-messages') THEN 'anthropic-messages'
              WHEN pi_api IN ('gemini', 'google-generative-ai') THEN 'google-generative-ai'
              ELSE 'openai-completions'
            END;
          END IF;
        END $$;
      `);
      await client.query(`
        ALTER TABLE official_model_configs
        ALTER COLUMN pi_api SET NOT NULL
      `);
      await client.query(`
        ALTER TABLE user_model_configs
        ALTER COLUMN pi_api SET NOT NULL
      `);
      await client.query(`DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'model_provider_configs'
          ) THEN
            UPDATE model_provider_configs
            SET provider_type = 'openai-compatible'
            WHERE provider_type IN ('openai', 'openai_compatible');

            INSERT INTO official_model_configs
              (
                id, model_key, pi_api, display_name, enabled, priority,
                base_url, model_name, api_key_secret_key, extra_json,
                created_at, updated_at
              )
            SELECT
              id,
              provider_key,
              CASE
                WHEN provider_type IN ('openai', 'openai_compatible', 'openai-compatible', 'openai-completions') THEN 'openai-completions'
                WHEN provider_type IN ('openai-response', 'openai_responses', 'openai-responses') THEN 'openai-responses'
                WHEN provider_type IN ('anthropic', 'anthropic-messages') THEN 'anthropic-messages'
                WHEN provider_type IN ('gemini', 'google-generative-ai') THEN 'google-generative-ai'
                ELSE 'openai-completions'
              END,
              display_name,
              enabled,
              priority,
              base_url,
              default_model,
              api_key_secret_key,
              COALESCE(extra_json, '{}'::jsonb),
              created_at,
              updated_at
            FROM model_provider_configs
            ON CONFLICT (id) DO NOTHING;
          END IF;
        END $$;`);
      await client.query(`
        UPDATE official_model_configs
        SET pi_api = 'openai-completions'
        WHERE pi_api IN ('openai', 'openai_compatible', 'openai-compatible')
      `);
      await client.query(`
        UPDATE user_model_configs
        SET pi_api = 'openai-completions'
        WHERE pi_api IN ('openai', 'openai_compatible', 'openai-compatible')
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_official_model_configs_enabled_priority
         ON official_model_configs(enabled DESC, priority ASC, updated_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_user_model_selections_official_model
         ON user_model_selections(official_model_id)
         WHERE official_model_id IS NOT NULL`,
      );
      await ensureCheckConstraint(client, {
        constraintName: 'chk_official_model_configs_pi_api_valid',
        tableName: 'official_model_configs',
        expression: `pi_api IN ('openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai')`,
        cleanupSql: `UPDATE official_model_configs
                     SET pi_api = 'openai-completions'
                     WHERE pi_api IN ('openai', 'openai_compatible', 'openai-compatible');
                     UPDATE official_model_configs
                     SET pi_api = 'openai-completions'
                     WHERE pi_api NOT IN ('openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai')`,
      });
      await client.query(`
        ALTER TABLE official_model_configs
        DROP COLUMN IF EXISTS protocol
      `);
      await client.query(`
        ALTER TABLE user_model_configs
        DROP COLUMN IF EXISTS protocol
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_user_model_configs_pi_api_valid',
        tableName: 'user_model_configs',
        expression: `pi_api IN ('openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai')`,
        cleanupSql: `UPDATE user_model_configs
                     SET pi_api = 'openai-completions'
                     WHERE pi_api IN ('openai', 'openai_compatible', 'openai-compatible');
                     UPDATE user_model_configs
                     SET pi_api = 'openai-completions'
                     WHERE pi_api NOT IN ('openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_user_model_selections_source_valid',
        tableName: 'user_model_selections',
        expression: `source IN ('custom', 'official')`,
        cleanupSql: `DELETE FROM user_model_selections
                     WHERE source NOT IN ('custom', 'official')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_user_model_selections_official_required',
        tableName: 'user_model_selections',
        expression: `(source = 'custom' AND official_model_id IS NULL)
                     OR (source = 'official' AND official_model_id IS NOT NULL)`,
        cleanupSql: `DELETE FROM user_model_selections
                     WHERE (source = 'custom' AND official_model_id IS NOT NULL)
                        OR (source = 'official' AND official_model_id IS NULL)`,
      });
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_config_audit_created_at
         ON config_audit_logs(created_at DESC)`,
      );
    },
  },
];
