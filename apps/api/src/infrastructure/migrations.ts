import type pg from 'pg';
import {
  appendLegacyTriggerHintToSkillBundle,
  writeTextSkillBundle,
} from '../modules/skills/text-skill-bundle-store.js';
import { deleteUsersWithoutValidPhone } from './phone-only-user-migration.js';

export interface DatabaseMigration {
  id: string;
  description: string;
  up(client: pg.PoolClient): Promise<void>;
}

async function tableExists(
  client: pg.PoolClient,
  tableName: string,
): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName],
  );
  return rows[0]?.exists ?? false;
}

async function columnExists(
  client: pg.PoolClient,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = $1
         AND column_name = $2
     ) AS exists`,
    [tableName, columnName],
  );
  return rows[0]?.exists ?? false;
}

async function migrateLegacyUserCustomSkillContentToBundles(
  client: pg.PoolClient,
): Promise<void> {
  const hasInlineContent = await columnExists(
    client,
    'user_custom_skills',
    'content',
  );
  const hasContentTable = await tableExists(
    client,
    'user_custom_skill_contents',
  );
  const hasTriggerHint = await columnExists(
    client,
    'user_custom_skills',
    'trigger_hint',
  );
  if (!hasInlineContent && !hasContentTable && !hasTriggerHint) return;

  const contentExpr =
    hasInlineContent && hasContentTable
      ? `COALESCE(sc.content, s.content, '')`
      : hasContentTable
        ? `COALESCE(sc.content, '')`
        : hasInlineContent
          ? `COALESCE(s.content, '')`
          : `''`;
  const triggerHintExpr = hasTriggerHint
    ? `COALESCE(s.trigger_hint, '')`
    : `''`;
  const contentJoin = hasContentTable
    ? `LEFT JOIN user_custom_skill_contents sc ON sc.skill_id = s.id`
    : '';
  const { rows } = await client.query<{
    id: string;
    user_id: string;
    skill_name: string;
    dir_name: string;
    description: string;
    trigger_hint: string;
    content: string;
  }>(
    `SELECT s.id, s.user_id, s.skill_name, s.dir_name, s.description,
            ${triggerHintExpr} AS trigger_hint, ${contentExpr} AS content
     FROM user_custom_skills s
     ${contentJoin}
     WHERE s.deleted_at IS NULL
       AND (
         s.bundle_uri IS NULL
         OR s.bundle_uri = ''
         OR s.install_status <> 'installed'
       )`,
  );

  for (const row of rows) {
    const bundle = writeTextSkillBundle({
      skillId: row.id,
      ownerId: row.user_id,
      dirName: row.dir_name,
      skillName: row.skill_name,
      description: row.description,
      triggerHint: row.trigger_hint,
      content: row.content ?? '',
    });
    await client.query(
      `UPDATE user_custom_skills
       SET bundle_uri = $1,
           checksum = $2,
           install_status = 'installed',
           audit_metadata = COALESCE(audit_metadata, '{}'::jsonb) || $3::jsonb,
           updated_at = NOW()
       WHERE id = $4`,
      [
        bundle.bundleUri,
        bundle.checksum,
        JSON.stringify({
          legacy_content_migrated_at: new Date().toISOString(),
          legacy_content_source: hasContentTable
            ? 'user_custom_skill_contents'
            : 'user_custom_skills.content',
        }),
        row.id,
      ],
    );
  }
}

async function migrateLegacyUserCustomSkillRoutingToBundles(
  client: pg.PoolClient,
): Promise<void> {
  const hasTriggerHint = await columnExists(
    client,
    'user_custom_skills',
    'trigger_hint',
  );
  if (!hasTriggerHint) return;

  const { rows } = await client.query<{
    id: string;
    bundle_uri: string;
    trigger_hint: string;
  }>(
    `SELECT id, bundle_uri, trigger_hint
     FROM user_custom_skills
     WHERE deleted_at IS NULL
       AND COALESCE(trigger_hint, '') <> ''
       AND COALESCE(bundle_uri, '') <> ''`,
  );

  for (const row of rows) {
    const checksum = appendLegacyTriggerHintToSkillBundle(
      row.bundle_uri,
      row.trigger_hint,
    );
    if (!checksum) continue;
    await client.query(
      `UPDATE user_custom_skills
       SET checksum = $1,
           audit_metadata = COALESCE(audit_metadata, '{}'::jsonb) || $2::jsonb,
           updated_at = NOW()
       WHERE id = $3`,
      [
        checksum,
        JSON.stringify({
          legacy_trigger_hint_migrated_at: new Date().toISOString(),
        }),
        row.id,
      ],
    );
  }
}

async function dropLegacyUserCustomSkillRoutingColumns(
  client: pg.PoolClient,
): Promise<void> {
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_user_custom_skills_usage_mode_valid'
      ) THEN
        ALTER TABLE user_custom_skills
          DROP CONSTRAINT chk_user_custom_skills_usage_mode_valid;
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_user_custom_skills_priority_nonnegative'
      ) THEN
        ALTER TABLE user_custom_skills
          DROP CONSTRAINT chk_user_custom_skills_priority_nonnegative;
      END IF;
    END $$;
  `);
  await client.query(
    `ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS trigger_hint`,
  );
  await client.query(
    `ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS category`,
  );
  await client.query(
    `ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS category_normalized`,
  );
  await client.query(
    `ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS match_keywords`,
  );
  await client.query(
    `ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS match_patterns`,
  );
  await client.query(
    `ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS example_queries`,
  );
  await client.query(
    `ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS priority`,
  );
  await client.query(
    `ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS usage_mode`,
  );
}

async function ensureForeignKey(
  client: pg.PoolClient,
  input: {
    constraintName: string;
    tableName: string;
    columnName: string;
    referencedTable: string;
    referencedColumn?: string;
    onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
    cleanupSql?: string;
  },
): Promise<void> {
  const referencedColumn = input.referencedColumn ?? 'id';
  const onDeleteClause = input.onDelete ? ` ON DELETE ${input.onDelete}` : '';
  const cleanupSql = input.cleanupSql ? `${input.cleanupSql};` : '';
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = '${input.constraintName}'
      ) THEN
        ${cleanupSql}
        ALTER TABLE ${input.tableName}
          ADD CONSTRAINT ${input.constraintName}
          FOREIGN KEY (${input.columnName})
          REFERENCES ${input.referencedTable}(${referencedColumn})${onDeleteClause};
      END IF;
    END $$;
  `);
}

async function ensureCheckConstraint(
  client: pg.PoolClient,
  input: {
    constraintName: string;
    tableName: string;
    expression: string;
    cleanupSql?: string;
  },
): Promise<void> {
  const cleanupSql = input.cleanupSql ? `${input.cleanupSql};` : '';
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = '${input.constraintName}'
      ) THEN
        ${cleanupSql}
        ALTER TABLE ${input.tableName}
          ADD CONSTRAINT ${input.constraintName}
          CHECK (${input.expression});
      END IF;
    END $$;
  `);
}

const MIGRATIONS: readonly DatabaseMigration[] = [
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
          role TEXT NOT NULL DEFAULT 'consumer',
          purchased_cents INTEGER NOT NULL DEFAULT 0,
          bonus_cents INTEGER NOT NULL DEFAULT 0,
          earned_cents INTEGER NOT NULL DEFAULT 0,
          reserved_cents INTEGER NOT NULL DEFAULT 0,
          pending_withdrawal_cents INTEGER NOT NULL DEFAULT 0,
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
      await client.query(`
        CREATE TABLE IF NOT EXISTS scheduled_tasks (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          prompt TEXT NOT NULL,
          schedule_type TEXT NOT NULL,
          schedule_value TEXT NOT NULL,
          reminder_type TEXT,
          voice_text TEXT,
          next_run TIMESTAMPTZ,
          last_run TIMESTAMPTZ,
          last_result TEXT,
          scheduler_locked_until TIMESTAMPTZ DEFAULT NULL,
          status TEXT DEFAULT 'active',
          created_at TIMESTAMPTZ NOT NULL,
          deleted_at TIMESTAMPTZ DEFAULT NULL
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON scheduled_tasks(next_run)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_tasks_status ON scheduled_tasks(status)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_tasks_account ON scheduled_tasks(account_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS task_run_logs (
          id SERIAL PRIMARY KEY,
          task_id TEXT NOT NULL,
          run_at TIMESTAMPTZ NOT NULL,
          duration_ms INTEGER NOT NULL,
          status TEXT NOT NULL,
          result TEXT,
          error TEXT,
          deleted_at TIMESTAMPTZ DEFAULT NULL,
          FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at)`,
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
  {
    id: '0003_application_schema_expansion',
    description: '迁移对话日志、自定义技能、订阅、计费和运行态扩展 schema',
    async up(client) {
      // 清理已停用的 soul_md_path 旧列，避免运行时继续维持无效字段。
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'accounts'
          ) THEN
            ALTER TABLE accounts DROP COLUMN IF EXISTS soul_md_path;
          END IF;
        END $$;
      `);
      // 对话日志表（工具调用链完整 transcript）
      await client.query(`
        CREATE TABLE IF NOT EXISTS conversation_logs (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          usage JSONB DEFAULT NULL,
          model TEXT DEFAULT NULL,
          provider TEXT DEFAULT NULL,
          transcript_event_count INTEGER NOT NULL DEFAULT 0,
          tool_call_count INTEGER NOT NULL DEFAULT 0,
          trace_event_count INTEGER NOT NULL DEFAULT 0,
          agent_graph_summary JSONB DEFAULT NULL,
          capability_ledger JSONB DEFAULT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `ALTER TABLE conversation_logs DROP CONSTRAINT IF EXISTS conversation_logs_account_id_fkey`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS conversation_log_payloads (
          log_id TEXT PRIMARY KEY REFERENCES conversation_logs(id) ON DELETE CASCADE,
          transcript JSONB NOT NULL DEFAULT '[]',
          trace_events JSONB DEFAULT NULL,
          agent_graph JSONB DEFAULT NULL
        )
      `);
      // 用户自定义知识 Skill
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_custom_skills (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          skill_name TEXT NOT NULL,
          dir_name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          version TEXT NOT NULL DEFAULT '1.0.0',
          bundle_uri TEXT NOT NULL DEFAULT '',
          checksum TEXT DEFAULT NULL,
          install_status TEXT NOT NULL DEFAULT 'missing',
          acl JSONB NOT NULL DEFAULT '{}'::jsonb,
          billing_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
          audit_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          visibility TEXT NOT NULL DEFAULT 'private',
          share_token TEXT UNIQUE,
          enabled BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at TIMESTAMPTZ DEFAULT NULL,
          UNIQUE(user_id, dir_name)
        )
      `);
      await client.query(
        `ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS version TEXT NOT NULL DEFAULT '1.0.0'`,
      );
      await client.query(
        `ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS bundle_uri TEXT NOT NULL DEFAULT ''`,
      );
      await client.query(
        `ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS checksum TEXT DEFAULT NULL`,
      );
      await client.query(
        `ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS install_status TEXT NOT NULL DEFAULT 'missing'`,
      );
      await client.query(
        `ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS acl JSONB NOT NULL DEFAULT '{}'::jsonb`,
      );
      await client.query(
        `ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS billing_policy JSONB NOT NULL DEFAULT '{}'::jsonb`,
      );
      await client.query(
        `ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS audit_metadata JSONB NOT NULL DEFAULT '{}'::jsonb`,
      );
      await client.query(
        `ALTER TABLE conversation_logs ADD COLUMN IF NOT EXISTS transcript_event_count INTEGER NOT NULL DEFAULT 0`,
      );
      await client.query(
        `ALTER TABLE conversation_logs ADD COLUMN IF NOT EXISTS tool_call_count INTEGER NOT NULL DEFAULT 0`,
      );
      await client.query(
        `ALTER TABLE conversation_logs ADD COLUMN IF NOT EXISTS trace_event_count INTEGER NOT NULL DEFAULT 0`,
      );
      await client.query(
        `ALTER TABLE conversation_logs ADD COLUMN IF NOT EXISTS agent_graph_summary JSONB DEFAULT NULL`,
      );
      await client.query(
        `ALTER TABLE conversation_logs ADD COLUMN IF NOT EXISTS capability_ledger JSONB DEFAULT NULL`,
      );
      // 清理旧 agent 架构遗留 schema
      await client.query(
        `ALTER TABLE conversation_logs DROP COLUMN IF EXISTS routing_decision`,
      );
      await client.query(`DROP TABLE IF EXISTS workflow_states`);
      await client.query(`DROP TABLE IF EXISTS xs_apis`);
      // 为 request_id 加 B-tree 索引，支撑 admin 按 requestId 排障查询
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_conversation_logs_request_id ON conversation_logs(request_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_conv_logs_account ON conversation_logs(account_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_conv_logs_created ON conversation_logs(created_at)`,
      );
      await client.query(`DO $$
        DECLARE
          has_transcript BOOLEAN;
          has_trace_events BOOLEAN;
          has_agent_graph BOOLEAN;
        BEGIN
          SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'conversation_logs' AND column_name = 'transcript'
          ) INTO has_transcript;
          SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'conversation_logs' AND column_name = 'trace_events'
          ) INTO has_trace_events;
          SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'conversation_logs' AND column_name = 'agent_graph'
          ) INTO has_agent_graph;
      
          IF has_transcript AND has_trace_events AND has_agent_graph THEN
            INSERT INTO conversation_log_payloads (log_id, transcript, trace_events, agent_graph)
            SELECT
              id,
              COALESCE(transcript, '[]'::jsonb),
              trace_events,
              agent_graph
            FROM conversation_logs
            ON CONFLICT (log_id) DO NOTHING;
          ELSIF has_transcript AND has_trace_events THEN
            INSERT INTO conversation_log_payloads (log_id, transcript, trace_events, agent_graph)
            SELECT
              id,
              COALESCE(transcript, '[]'::jsonb),
              trace_events,
              NULL::jsonb
            FROM conversation_logs
            ON CONFLICT (log_id) DO NOTHING;
          ELSIF has_transcript AND has_agent_graph THEN
            INSERT INTO conversation_log_payloads (log_id, transcript, trace_events, agent_graph)
            SELECT
              id,
              COALESCE(transcript, '[]'::jsonb),
              NULL::jsonb,
              agent_graph
            FROM conversation_logs
            ON CONFLICT (log_id) DO NOTHING;
          ELSIF has_transcript THEN
            INSERT INTO conversation_log_payloads (log_id, transcript, trace_events, agent_graph)
            SELECT
              id,
              COALESCE(transcript, '[]'::jsonb),
              NULL::jsonb,
              NULL::jsonb
            FROM conversation_logs
            ON CONFLICT (log_id) DO NOTHING;
          END IF;
        END $$;`);
      await client.query(`
        WITH payload_stats AS (
          SELECT
            p.log_id,
            jsonb_array_length(COALESCE(p.transcript, '[]'::jsonb))::int AS transcript_event_count,
            (
              SELECT COUNT(*)::int
              FROM jsonb_array_elements(COALESCE(p.transcript, '[]'::jsonb)) e
              WHERE e->>'type' = 'tool_use'
            ) AS tool_call_count,
            jsonb_array_length(COALESCE(p.trace_events, '[]'::jsonb))::int AS trace_event_count,
            CASE
              WHEN p.agent_graph IS NOT NULL AND jsonb_typeof(p.agent_graph) = 'object'
                THEN p.agent_graph->'summary'
              ELSE NULL
            END AS derived_agent_graph_summary
          FROM conversation_log_payloads p
        )
        UPDATE conversation_logs l
        SET transcript_event_count = ps.transcript_event_count,
            tool_call_count = ps.tool_call_count,
            trace_event_count = ps.trace_event_count,
            agent_graph_summary = COALESCE(l.agent_graph_summary, ps.derived_agent_graph_summary)
        FROM payload_stats ps
        WHERE l.id = ps.log_id
          AND (
            l.transcript_event_count IS DISTINCT FROM ps.transcript_event_count
            OR l.tool_call_count IS DISTINCT FROM ps.tool_call_count
            OR l.trace_event_count IS DISTINCT FROM ps.trace_event_count
            OR l.agent_graph_summary IS DISTINCT FROM COALESCE(l.agent_graph_summary, ps.derived_agent_graph_summary)
          )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_ucs_user ON user_custom_skills(user_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_ucs_share_token ON user_custom_skills(share_token)`,
      );
      await client.query(
        `ALTER TABLE user_custom_skills DROP CONSTRAINT IF EXISTS user_custom_skills_user_id_dir_name_key`,
      );
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_ucs_user_dir_active
         ON user_custom_skills(user_id, dir_name)
         WHERE deleted_at IS NULL`,
      );
      await migrateLegacyUserCustomSkillContentToBundles(client);
      await migrateLegacyUserCustomSkillRoutingToBundles(client);
      await dropLegacyUserCustomSkillRoutingColumns(client);
      await client.query(`DROP TABLE IF EXISTS user_custom_skill_contents`);
      // 用户 Skill 订阅关系
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_skill_subscriptions (
          id TEXT PRIMARY KEY,
          subscriber_id TEXT NOT NULL,
          skill_id TEXT NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT true,
          subscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(subscriber_id, skill_id)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_uss_subscriber ON user_skill_subscriptions(subscriber_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_uss_skill ON user_skill_subscriptions(skill_id)`,
      );
      // Skill 收费扩展
      await client.query(
        `ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS price_tiers JSONB NOT NULL DEFAULT '[]'`,
      );
      await client.query(
        `ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS stat_subscriber_count INTEGER NOT NULL DEFAULT 0`,
      );
      await client.query(
        `ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS stat_view_count INTEGER NOT NULL DEFAULT 0`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_ucs_market_listing
         ON user_custom_skills(stat_subscriber_count DESC, created_at DESC)
         WHERE deleted_at IS NULL AND visibility = 'shared'`,
      );
      await client.query(
        `DROP INDEX IF EXISTS idx_ucs_market_category_listing`,
      );
      await client.query(
        `ALTER TABLE user_skill_subscriptions ADD COLUMN IF NOT EXISTS tier_key TEXT DEFAULT NULL`,
      );
      await client.query(
        `ALTER TABLE user_skill_subscriptions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`,
      );
      await client.query(
        `ALTER TABLE user_skill_subscriptions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT NULL`,
      );
      await client.query(
        `ALTER TABLE user_skill_subscriptions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      );
      await client.query(
        `ALTER TABLE user_skill_subscriptions ADD COLUMN IF NOT EXISTS has_direct_source BOOLEAN NOT NULL DEFAULT true`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_uss_subscriber_enabled_active_expiry
         ON user_skill_subscriptions(subscriber_id, expires_at)
         WHERE enabled = true AND status = 'active'`,
      );
      await client.query(`
        WITH sub_counts AS (
          SELECT skill_id, COUNT(*)::int AS cnt
          FROM user_skill_subscriptions
          GROUP BY skill_id
        )
        UPDATE user_custom_skills s
        SET stat_subscriber_count = COALESCE(sc.cnt, 0),
            updated_at = CASE
              WHEN s.stat_subscriber_count IS DISTINCT FROM COALESCE(sc.cnt, 0)
                THEN NOW()
              ELSE s.updated_at
            END
        FROM (
          SELECT ucs.id, sub_counts.cnt
          FROM user_custom_skills ucs
          LEFT JOIN sub_counts ON sub_counts.skill_id = ucs.id
        ) sc
        WHERE s.id = sc.id
          AND s.stat_subscriber_count IS DISTINCT FROM COALESCE(sc.cnt, 0)
      `);
      // 创作者整包订阅
      await client.query(`
        CREATE TABLE IF NOT EXISTS creator_bundle_subscriptions (
          id TEXT PRIMARY KEY,
          subscriber_id TEXT NOT NULL REFERENCES users(id),
          creator_id TEXT NOT NULL,
          tier_key TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          expires_at TIMESTAMPTZ DEFAULT NULL,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          source TEXT NOT NULL DEFAULT 'web',
          UNIQUE(subscriber_id, creator_id)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_bundle_sub_subscriber ON creator_bundle_subscriptions(subscriber_id, status)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_bundle_sub_creator ON creator_bundle_subscriptions(creator_id, status)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_bundle_sub_subscriber_active_expiry
         ON creator_bundle_subscriptions(subscriber_id, expires_at)
         WHERE status = 'active'`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS creator_bundle_config (
          creator_id TEXT PRIMARY KEY REFERENCES users(id),
          bundle_tiers JSONB NOT NULL DEFAULT '[]',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // Skill 捆绑包：创作者可自由组合多个自有 skill 生成独立分享链接
      await client.query(`
        CREATE TABLE IF NOT EXISTS skill_bundles (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          bundle_token TEXT UNIQUE,
          visibility TEXT NOT NULL DEFAULT 'private',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at TIMESTAMPTZ DEFAULT NULL
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS skill_bundle_items (
          bundle_id TEXT NOT NULL REFERENCES skill_bundles(id) ON DELETE CASCADE,
          skill_id TEXT NOT NULL REFERENCES user_custom_skills(id) ON DELETE CASCADE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (bundle_id, skill_id)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_skill_bundles_user ON skill_bundles(user_id) WHERE deleted_at IS NULL`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_skill_bundles_token ON skill_bundles(bundle_token) WHERE bundle_token IS NOT NULL`,
      );
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_bundle_items_bundle_order
         ON skill_bundle_items(bundle_id, sort_order)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_skill_bundle_items_skill
         ON skill_bundle_items(skill_id)`,
      );
      await client.query(`DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'skill_bundles' AND column_name = 'skill_ids'
          ) THEN
            INSERT INTO skill_bundle_items (bundle_id, skill_id, sort_order)
            SELECT normalized.bundle_id, normalized.skill_id, normalized.sort_order
            FROM (
              SELECT
                b.id AS bundle_id,
                items.skill_id,
                (items.ordinality - 1)::int AS sort_order,
                ROW_NUMBER() OVER (
                  PARTITION BY b.id, items.skill_id
                  ORDER BY items.ordinality
                ) AS skill_rank
              FROM skill_bundles b
              CROSS JOIN LATERAL jsonb_array_elements_text(
                COALESCE(b.skill_ids, '[]'::jsonb)
              ) WITH ORDINALITY AS items(skill_id, ordinality)
            ) normalized
            WHERE normalized.skill_rank = 1
            ON CONFLICT (bundle_id, skill_id) DO UPDATE SET
              sort_order = EXCLUDED.sort_order;
          END IF;
        END $$;`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_skill_subscription_bundle_sources (
          subscription_id TEXT NOT NULL REFERENCES user_skill_subscriptions(id) ON DELETE CASCADE,
          bundle_id TEXT NOT NULL REFERENCES skill_bundles(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (subscription_id, bundle_id)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_uss_bundle_sources_bundle
         ON user_skill_subscription_bundle_sources(bundle_id)`,
      );
      await client.query(`DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'user_skill_subscriptions'
              AND column_name = 'source_bundle_id'
          ) THEN
            INSERT INTO user_skill_subscription_bundle_sources (subscription_id, bundle_id)
            SELECT sub.id, sub.source_bundle_id
            FROM user_skill_subscriptions sub
            JOIN skill_bundles b ON b.id = sub.source_bundle_id
            WHERE sub.source_bundle_id IS NOT NULL
            ON CONFLICT (subscription_id, bundle_id) DO NOTHING;
            UPDATE user_skill_subscriptions
            SET has_direct_source = false
            WHERE source_bundle_id IS NOT NULL;
          END IF;
        END $$;`);
      await client.query(
        `ALTER TABLE user_skill_subscriptions DROP COLUMN IF EXISTS source_bundle_id`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS wallet_transactions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          kind TEXT NOT NULL,
          amount_cents INTEGER NOT NULL DEFAULT 0,
          reserved_delta_cents INTEGER NOT NULL DEFAULT 0,
          balance_source TEXT DEFAULT NULL,
          balance_grant_id TEXT DEFAULT NULL,
          request_id TEXT DEFAULT NULL,
          note TEXT DEFAULT NULL,
          metadata JSONB DEFAULT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_created_at ON wallet_transactions(user_id, created_at DESC)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS recharge_payment_config (
          id TEXT PRIMARY KEY DEFAULT 'default',
          enabled BOOLEAN NOT NULL DEFAULT FALSE,
          min_yuan NUMERIC(12,2) NOT NULL DEFAULT 1,
          max_yuan NUMERIC(12,2) NOT NULL DEFAULT 1000,
          epay_url_prefix TEXT NOT NULL DEFAULT '',
          epay_platform_id INTEGER DEFAULT NULL,
          epay_merchant_private_key TEXT NOT NULL DEFAULT '',
          epay_platform_public_key TEXT NOT NULL DEFAULT '',
          epay_merchant_key TEXT NOT NULL DEFAULT '',
          notify_url TEXT NOT NULL DEFAULT '',
          return_url TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        INSERT INTO recharge_payment_config (id)
        VALUES ('default')
        ON CONFLICT (id) DO NOTHING
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS recharge_orders (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          trade_id TEXT NOT NULL UNIQUE,
          provider TEXT NOT NULL DEFAULT 'epay',
          provider_trade_id TEXT DEFAULT NULL,
          pay_type TEXT NOT NULL,
          amount_yuan NUMERIC(12,2) NOT NULL,
          amount_cents INTEGER NOT NULL,
          pay_url TEXT DEFAULT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          paid_at TIMESTAMPTZ DEFAULT NULL,
          notified_at TIMESTAMPTZ DEFAULT NULL,
          metadata JSONB DEFAULT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_recharge_orders_user_created_at
         ON recharge_orders(user_id, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_recharge_orders_status_created_at
         ON recharge_orders(status, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_recharge_orders_status_paid_at
         ON recharge_orders(status, paid_at DESC)
         WHERE paid_at IS NOT NULL`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS monthly_billing_state (
          user_id TEXT NOT NULL REFERENCES users(id),
          year_month TEXT NOT NULL,
          billed_overage_tokens INTEGER NOT NULL DEFAULT 0,
          billed_overage_cost_cents INTEGER NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, year_month)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS billing_request_reservations (
          request_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          model_config_id TEXT DEFAULT NULL,
          year_month TEXT NOT NULL,
          reserved_cents INTEGER NOT NULL DEFAULT 0,
          hold_state TEXT NOT NULL DEFAULT 'none',
          charge_state TEXT NOT NULL DEFAULT 'pending',
          actual_charge_cents INTEGER NOT NULL DEFAULT 0,
          total_overage_tokens INTEGER NOT NULL DEFAULT 0,
          total_overage_cost_cents INTEGER NOT NULL DEFAULT 0,
          note TEXT DEFAULT NULL,
          metadata JSONB DEFAULT NULL,
          released_at TIMESTAMPTZ DEFAULT NULL,
          charged_at TIMESTAMPTZ DEFAULT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_billing_request_reservations_user_created_at ON billing_request_reservations(user_id, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_billing_request_reservations_hold_state ON billing_request_reservations(hold_state, charge_state, updated_at)`,
      );
      // AI 对话会话表
      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_sessions (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          user_id TEXT DEFAULT NULL REFERENCES users(id),
          title TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at TIMESTAMPTZ DEFAULT NULL
        )
      `);
      // 站内 AI Chat 已从微信账号中拆出，account_id 在聊天表中表示运行时会话键。
      await client.query(
        `ALTER TABLE chat_sessions DROP CONSTRAINT IF EXISTS chat_sessions_account_id_fkey`,
      );
      await client.query(
        `ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT NULL REFERENCES users(id)`,
      );
      await client.query(
        `UPDATE chat_sessions s
         SET user_id = a.owner_id
         FROM accounts a
         WHERE s.user_id IS NULL AND s.account_id = a.id AND a.owner_id IS NOT NULL`,
      );
      await client.query(
        `UPDATE chat_sessions s
         SET account_id = CONCAT('web:', a.owner_id),
             user_id = a.owner_id
         FROM accounts a
         WHERE a.base_url = 'internal://ai-chat'
           AND s.account_id = a.id
           AND a.owner_id IS NOT NULL`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_chat_sessions_account_updated
         ON chat_sessions(account_id, updated_at DESC)
         WHERE deleted_at IS NULL`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_updated
         ON chat_sessions(user_id, updated_at DESC)
         WHERE deleted_at IS NULL`,
      );
      // messages 表增加 session_id（AI 对话消息才有值，微信消息为 NULL）
      await client.query(
        `ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_account_id_fkey`,
      );
      await client.query(
        `ALTER TABLE messages ADD COLUMN IF NOT EXISTS session_id TEXT DEFAULT NULL`,
      );
      await client.query(
        `ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT NULL REFERENCES users(id)`,
      );
      await client.query(
        `ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT NULL`,
      );
      await client.query(
        `UPDATE messages m
         SET user_id = COALESCE(s.user_id, a.owner_id)
         FROM chat_sessions s
         LEFT JOIN accounts a ON a.id = s.account_id
         WHERE m.user_id IS NULL
           AND m.session_id = s.id
           AND COALESCE(s.user_id, a.owner_id) IS NOT NULL`,
      );
      await client.query(
        `UPDATE messages m
         SET account_id = s.account_id,
             user_id = s.user_id
         FROM chat_sessions s
         WHERE m.session_id = s.id
           AND s.user_id IS NOT NULL
           AND (
             m.account_id IS DISTINCT FROM s.account_id
             OR m.user_id IS DISTINCT FROM s.user_id
           )`,
      );
      await client.query(
        `UPDATE conversation_logs l
         SET account_id = CONCAT('web:', a.owner_id)
         FROM accounts a
         WHERE a.base_url = 'internal://ai-chat'
           AND l.account_id = a.id
           AND a.owner_id IS NOT NULL`,
      );
      await client.query(
        `DELETE FROM accounts WHERE base_url = 'internal://ai-chat'`,
      );
      await client.query(
        `DELETE FROM task_run_logs
         WHERE task_id IN (
           SELECT id FROM scheduled_tasks
           WHERE account_id IN (SELECT id FROM accounts)
         )`,
      );
      await client.query(
        `DELETE FROM scheduled_tasks
         WHERE account_id IN (SELECT id FROM accounts)`,
      );
      await client.query(
        `DELETE FROM messages
         WHERE session_id IS NULL
           AND account_id IN (SELECT id FROM accounts)`,
      );
      await client.query(
        `DELETE FROM conversation_logs
         WHERE account_id IN (SELECT id FROM accounts)`,
      );
      await client.query(`DELETE FROM accounts`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id) WHERE session_id IS NOT NULL`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_messages_user_session_timestamp_active
         ON messages(user_id, session_id, timestamp DESC)
         WHERE deleted_at IS NULL AND session_id IS NOT NULL`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_messages_account_timestamp_active
         ON messages(account_id, timestamp DESC)
         WHERE deleted_at IS NULL AND session_id IS NULL`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp_active
         ON messages(session_id, timestamp DESC)
         WHERE deleted_at IS NULL AND session_id IS NOT NULL`,
      );
      await client.query(
        `ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS scheduler_locked_until TIMESTAMPTZ DEFAULT NULL`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_tasks_due_lock
         ON scheduled_tasks(status, next_run, scheduler_locked_until)
         WHERE deleted_at IS NULL`,
      );

      await client.query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'consumer'`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS creator_earnings_monthly (
          creator_id TEXT NOT NULL REFERENCES users(id),
          year_month TEXT NOT NULL,
          gross_cents INTEGER NOT NULL DEFAULT 0,
          platform_cut_cents INTEGER NOT NULL DEFAULT 0,
          net_cents INTEGER NOT NULL DEFAULT 0,
          withdrawn_cents INTEGER NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (creator_id, year_month)
        )
      `);

      // ─── 为老库补齐余额相关列 ────────────────────────────────
      // CREATE TABLE IF NOT EXISTS 对已存在的表是 no-op，所以依赖 ALTER ADD COLUMN
      // IF NOT EXISTS 把新列补到历史表上。新环境这些语句全部 no-op。

      // users 三段式余额 + 提现冻结
      await client.query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS purchased_cents INTEGER NOT NULL DEFAULT 0`,
      );
      await client.query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_cents INTEGER NOT NULL DEFAULT 0`,
      );
      await client.query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS earned_cents INTEGER NOT NULL DEFAULT 0`,
      );
      await client.query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS reserved_cents INTEGER NOT NULL DEFAULT 0`,
      );
      await client.query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_withdrawal_cents INTEGER NOT NULL DEFAULT 0`,
      );

      // wallet_transactions 余额字段
      await client.query(
        `ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS amount_cents INTEGER NOT NULL DEFAULT 0`,
      );
      await client.query(
        `ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS reserved_delta_cents INTEGER NOT NULL DEFAULT 0`,
      );
      await client.query(
        `ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS balance_source TEXT DEFAULT NULL`,
      );
      await client.query(
        `ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS balance_grant_id TEXT DEFAULT NULL`,
      );

      // billing_request_reservations 余额字段
      await client.query(`DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'billing_request_reservations'
              AND column_name = 'plan_id'
          ) AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'billing_request_reservations'
              AND column_name = 'model_config_id'
          ) THEN
            ALTER TABLE billing_request_reservations
              RENAME COLUMN plan_id TO model_config_id;
          END IF;
        END $$;`);
      await client.query(
        `ALTER TABLE billing_request_reservations ADD COLUMN IF NOT EXISTS model_config_id TEXT DEFAULT NULL`,
      );
      await client.query(
        `ALTER TABLE billing_request_reservations ADD COLUMN IF NOT EXISTS reserved_cents INTEGER NOT NULL DEFAULT 0`,
      );
      await client.query(
        `ALTER TABLE billing_request_reservations ADD COLUMN IF NOT EXISTS actual_charge_cents INTEGER NOT NULL DEFAULT 0`,
      );
      await client.query(
        `ALTER TABLE billing_request_reservations ADD COLUMN IF NOT EXISTS total_overage_cost_cents INTEGER NOT NULL DEFAULT 0`,
      );

      // monthly_billing_state 余额版防重扣
      await client.query(
        `ALTER TABLE monthly_billing_state ADD COLUMN IF NOT EXISTS billed_overage_cost_cents INTEGER NOT NULL DEFAULT 0`,
      );

      // creator_earnings_monthly 余额版
      await client.query(
        `ALTER TABLE creator_earnings_monthly ADD COLUMN IF NOT EXISTS gross_cents INTEGER NOT NULL DEFAULT 0`,
      );
      await client.query(
        `ALTER TABLE creator_earnings_monthly ADD COLUMN IF NOT EXISTS platform_cut_cents INTEGER NOT NULL DEFAULT 0`,
      );
      await client.query(
        `ALTER TABLE creator_earnings_monthly ADD COLUMN IF NOT EXISTS net_cents INTEGER NOT NULL DEFAULT 0`,
      );
      await client.query(
        `ALTER TABLE creator_earnings_monthly ADD COLUMN IF NOT EXISTS withdrawn_cents INTEGER NOT NULL DEFAULT 0`,
      );

      // balance_grants：赠送余额批次（FIFO 扣减 + 过期管理）
      await client.query(`
        CREATE TABLE IF NOT EXISTS balance_grants (
          id               TEXT PRIMARY KEY,
          user_id          TEXT NOT NULL REFERENCES users(id),
          source           TEXT NOT NULL,
          granted_by       TEXT DEFAULT NULL,
          amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
          remaining_cents INTEGER NOT NULL,
          note             TEXT DEFAULT NULL,
          expires_at       TIMESTAMPTZ DEFAULT NULL,
          status           TEXT NOT NULL DEFAULT 'active',
          created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_balance_grants_user_active
         ON balance_grants(user_id, expires_at, remaining_cents)
         WHERE status = 'active'`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_balance_grants_expiry_scan
         ON balance_grants(expires_at)
         WHERE status = 'active' AND expires_at IS NOT NULL`,
      );

      // creator_withdrawals：创作者提现申请（独立于消费钱包）
      await client.query(`
        CREATE TABLE IF NOT EXISTS creator_withdrawals (
          id                   TEXT PRIMARY KEY,
          creator_id           TEXT NOT NULL REFERENCES users(id),
          amount_cents        INTEGER NOT NULL CHECK (amount_cents > 0),
          amount_yuan          NUMERIC(12,2) NOT NULL,
          status               TEXT NOT NULL DEFAULT 'pending',
          bank_name            TEXT DEFAULT NULL,
          bank_account         TEXT DEFAULT NULL,
          account_name         TEXT DEFAULT NULL,
          id_number            TEXT DEFAULT NULL,
          tax_type             TEXT DEFAULT NULL,
          company_name         TEXT DEFAULT NULL,
          tax_id               TEXT DEFAULT NULL,
          platform_fee_cents  INTEGER NOT NULL DEFAULT 0,
          tax_amount_yuan      NUMERIC(12,2) NOT NULL DEFAULT 0,
          net_amount_yuan      NUMERIC(12,2) NOT NULL DEFAULT 0,
          reviewed_by          TEXT DEFAULT NULL,
          reviewed_at          TIMESTAMPTZ DEFAULT NULL,
          review_note          TEXT DEFAULT NULL,
          paid_at              TIMESTAMPTZ DEFAULT NULL,
          payment_proof        TEXT DEFAULT NULL,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_creator_withdrawals_creator
         ON creator_withdrawals(creator_id, status, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_creator_withdrawals_pending
         ON creator_withdrawals(status, created_at DESC)
         WHERE status IN ('pending', 'approved')`,
      );

      await ensureForeignKey(client, {
        constraintName: 'fk_user_custom_skills_user_id',
        tableName: 'user_custom_skills',
        columnName: 'user_id',
        referencedTable: 'users',
        onDelete: 'CASCADE',
        cleanupSql: `DELETE FROM user_custom_skills ucs
                     WHERE NOT EXISTS (
                       SELECT 1 FROM users u WHERE u.id = ucs.user_id
                     )`,
      });
      await ensureForeignKey(client, {
        constraintName: 'fk_user_skill_subscriptions_subscriber_id',
        tableName: 'user_skill_subscriptions',
        columnName: 'subscriber_id',
        referencedTable: 'users',
        onDelete: 'CASCADE',
        cleanupSql: `DELETE FROM user_skill_subscriptions sub
                     WHERE NOT EXISTS (
                       SELECT 1 FROM users u WHERE u.id = sub.subscriber_id
                     )`,
      });
      await ensureForeignKey(client, {
        constraintName: 'fk_user_skill_subscriptions_skill_id',
        tableName: 'user_skill_subscriptions',
        columnName: 'skill_id',
        referencedTable: 'user_custom_skills',
        onDelete: 'CASCADE',
        cleanupSql: `DELETE FROM user_skill_subscriptions sub
                     WHERE NOT EXISTS (
                       SELECT 1 FROM user_custom_skills s WHERE s.id = sub.skill_id
                     )`,
      });
      await ensureForeignKey(client, {
        constraintName: 'fk_creator_bundle_subscriptions_creator_id',
        tableName: 'creator_bundle_subscriptions',
        columnName: 'creator_id',
        referencedTable: 'users',
        onDelete: 'CASCADE',
        cleanupSql: `DELETE FROM creator_bundle_subscriptions sub
                     WHERE NOT EXISTS (
                       SELECT 1 FROM users u WHERE u.id = sub.creator_id
                     )`,
      });
      await ensureForeignKey(client, {
        constraintName: 'fk_messages_session_id',
        tableName: 'messages',
        columnName: 'session_id',
        referencedTable: 'chat_sessions',
        onDelete: 'SET NULL',
        cleanupSql: `UPDATE messages m
                     SET session_id = NULL
                     WHERE session_id IS NOT NULL
                       AND NOT EXISTS (
                         SELECT 1 FROM chat_sessions s WHERE s.id = m.session_id
                       )`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_users_role_valid',
        tableName: 'users',
        expression: `role IN ('consumer', 'creator', 'both', 'admin')`,
        cleanupSql: `UPDATE users
                     SET role = 'consumer'
                     WHERE role NOT IN ('consumer', 'creator', 'both', 'admin')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_user_custom_skills_visibility_valid',
        tableName: 'user_custom_skills',
        expression: `visibility IN ('private', 'link_shared', 'shared')`,
        cleanupSql: `UPDATE user_custom_skills
                     SET visibility = 'private',
                         share_token = NULL
                     WHERE visibility NOT IN ('private', 'link_shared', 'shared')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_skill_bundles_visibility_valid',
        tableName: 'skill_bundles',
        expression: `visibility IN ('private', 'link_shared', 'shared')`,
        cleanupSql: `UPDATE skill_bundles
                     SET visibility = 'private',
                         bundle_token = NULL
                     WHERE visibility NOT IN ('private', 'link_shared', 'shared')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_user_skill_subscriptions_status_valid',
        tableName: 'user_skill_subscriptions',
        expression: `status IN ('active', 'expired', 'cancelled')`,
        cleanupSql: `UPDATE user_skill_subscriptions
                     SET status = 'active'
                     WHERE status NOT IN ('active', 'expired', 'cancelled')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_creator_bundle_subscriptions_status_valid',
        tableName: 'creator_bundle_subscriptions',
        expression: `status IN ('active', 'expired', 'cancelled')`,
        cleanupSql: `UPDATE creator_bundle_subscriptions
                     SET status = 'active'
                     WHERE status NOT IN ('active', 'expired', 'cancelled')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_scheduled_tasks_schedule_type_valid',
        tableName: 'scheduled_tasks',
        expression: `schedule_type IN ('cron', 'interval', 'once')`,
        cleanupSql: `UPDATE scheduled_tasks
                     SET schedule_type = 'once'
                     WHERE schedule_type NOT IN ('cron', 'interval', 'once')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_scheduled_tasks_status_valid',
        tableName: 'scheduled_tasks',
        expression: `status IN ('active', 'paused', 'completed')`,
        cleanupSql: `UPDATE scheduled_tasks
                     SET status = 'active'
                     WHERE status NOT IN ('active', 'paused', 'completed')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_billing_request_reservations_hold_state_valid',
        tableName: 'billing_request_reservations',
        expression: `hold_state IN ('none', 'held', 'released')`,
        cleanupSql: `UPDATE billing_request_reservations
                     SET hold_state = 'none'
                     WHERE hold_state NOT IN ('none', 'held', 'released')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_billing_request_reservations_charge_state_valid',
        tableName: 'billing_request_reservations',
        expression: `charge_state IN ('pending', 'charged')`,
        cleanupSql: `UPDATE billing_request_reservations
                     SET charge_state = 'pending'
                     WHERE charge_state NOT IN ('pending', 'charged')`,
      });
      await ensureCheckConstraint(client, {
        constraintName:
          'chk_billing_request_reservations_reserved_cents_nonnegative',
        tableName: 'billing_request_reservations',
        expression: 'reserved_cents >= 0',
        cleanupSql: `UPDATE billing_request_reservations
                     SET reserved_cents = 0
                     WHERE reserved_cents < 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName:
          'chk_billing_request_reservations_actual_charge_cents_nonnegative',
        tableName: 'billing_request_reservations',
        expression: 'actual_charge_cents >= 0',
        cleanupSql: `UPDATE billing_request_reservations
                     SET actual_charge_cents = 0
                     WHERE actual_charge_cents < 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName:
          'chk_billing_request_reservations_total_overage_tokens_nonnegative',
        tableName: 'billing_request_reservations',
        expression: 'total_overage_tokens >= 0',
        cleanupSql: `UPDATE billing_request_reservations
                     SET total_overage_tokens = 0
                     WHERE total_overage_tokens < 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName:
          'chk_billing_request_reservations_total_overage_cost_cents_nonnegative',
        tableName: 'billing_request_reservations',
        expression: 'total_overage_cost_cents >= 0',
        cleanupSql: `UPDATE billing_request_reservations
                     SET total_overage_cost_cents = 0
                     WHERE total_overage_cost_cents < 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_recharge_payment_config_min_yuan_positive',
        tableName: 'recharge_payment_config',
        expression: 'min_yuan > 0',
        cleanupSql: `UPDATE recharge_payment_config
                     SET min_yuan = 1
                     WHERE min_yuan <= 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_recharge_payment_config_max_yuan_valid',
        tableName: 'recharge_payment_config',
        expression: 'max_yuan >= min_yuan',
        cleanupSql: `UPDATE recharge_payment_config
                     SET max_yuan = GREATEST(min_yuan, 1000)
                     WHERE max_yuan < min_yuan`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_recharge_payment_config_platform_id_positive',
        tableName: 'recharge_payment_config',
        expression: 'epay_platform_id IS NULL OR epay_platform_id > 0',
        cleanupSql: `UPDATE recharge_payment_config
                     SET epay_platform_id = NULL
                     WHERE epay_platform_id IS NOT NULL
                       AND epay_platform_id <= 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_recharge_orders_pay_type_valid',
        tableName: 'recharge_orders',
        expression: `pay_type IN ('alipay', 'wechat')`,
        cleanupSql: `UPDATE recharge_orders
                     SET pay_type = 'alipay'
                     WHERE pay_type NOT IN ('alipay', 'wechat')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_recharge_orders_status_valid',
        tableName: 'recharge_orders',
        expression: `status IN ('pending', 'paid', 'failed')`,
        cleanupSql: `UPDATE recharge_orders
                     SET status = 'pending'
                     WHERE status NOT IN ('pending', 'paid', 'failed')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_recharge_orders_amount_cents_positive',
        tableName: 'recharge_orders',
        expression: 'amount_cents > 0',
        cleanupSql: `UPDATE recharge_orders
                     SET amount_cents = 1
                     WHERE amount_cents <= 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_recharge_orders_amount_yuan_positive',
        tableName: 'recharge_orders',
        expression: 'amount_yuan > 0',
        cleanupSql: `UPDATE recharge_orders
                     SET amount_yuan = 0.01
                     WHERE amount_yuan <= 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_balance_grants_status_valid',
        tableName: 'balance_grants',
        expression: `status IN ('active', 'exhausted', 'expired', 'revoked')`,
        cleanupSql: `UPDATE balance_grants
                     SET status = 'active'
                     WHERE status NOT IN ('active', 'exhausted', 'expired', 'revoked')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_balance_grants_remaining_cents_range',
        tableName: 'balance_grants',
        expression:
          'remaining_cents >= 0 AND remaining_cents <= amount_cents',
        cleanupSql: `UPDATE balance_grants
                     SET remaining_cents = LEAST(amount_cents, GREATEST(remaining_cents, 0))
                     WHERE remaining_cents < 0 OR remaining_cents > amount_cents`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_creator_withdrawals_status_valid',
        tableName: 'creator_withdrawals',
        expression: `status IN ('pending', 'approved', 'rejected', 'paid', 'cancelled')`,
        cleanupSql: `UPDATE creator_withdrawals
                     SET status = 'pending'
                     WHERE status NOT IN ('pending', 'approved', 'rejected', 'paid', 'cancelled')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_creator_withdrawals_tax_type_valid',
        tableName: 'creator_withdrawals',
        expression: `tax_type IS NULL OR tax_type IN ('personal', 'company')`,
        cleanupSql: `UPDATE creator_withdrawals
                     SET tax_type = NULL
                     WHERE tax_type IS NOT NULL
                       AND tax_type NOT IN ('personal', 'company')`,
      });
      await ensureCheckConstraint(client, {
        constraintName:
          'chk_creator_withdrawals_platform_fee_cents_nonnegative',
        tableName: 'creator_withdrawals',
        expression: 'platform_fee_cents >= 0',
        cleanupSql: `UPDATE creator_withdrawals
                     SET platform_fee_cents = 0
                     WHERE platform_fee_cents < 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_creator_withdrawals_tax_amount_yuan_nonnegative',
        tableName: 'creator_withdrawals',
        expression: 'tax_amount_yuan >= 0',
        cleanupSql: `UPDATE creator_withdrawals
                     SET tax_amount_yuan = 0
                     WHERE tax_amount_yuan < 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_creator_withdrawals_net_amount_yuan_nonnegative',
        tableName: 'creator_withdrawals',
        expression: 'net_amount_yuan >= 0',
        cleanupSql: `UPDATE creator_withdrawals
                     SET net_amount_yuan = 0
                     WHERE net_amount_yuan < 0`,
      });

      // ─── 历史迁移：保留早期分余额列的值（幂等） ─────
      // 早期版本已经用 *_cents 存储金额；后续余额版本会由 0008 统一改回 cents。
      await client.query(`DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'users' AND column_name = 'balance_cents'
          ) THEN
            UPDATE users
              SET purchased_cents = balance_cents,
                  reserved_cents  = reserved_balance_cents
            WHERE purchased_cents = 0
              AND reserved_cents = 0
              AND (balance_cents > 0 OR reserved_balance_cents > 0);
          END IF;
        END $$;`);

      // ─── 清理：DROP 早期余额别名列（幂等） ───────────────────
      await client.query(
        `ALTER TABLE users
           DROP COLUMN IF EXISTS balance_cents,
           DROP COLUMN IF EXISTS reserved_balance_cents`,
      );
      await client.query(
        `ALTER TABLE conversation_logs
           DROP COLUMN IF EXISTS transcript,
           DROP COLUMN IF EXISTS trace_events,
           DROP COLUMN IF EXISTS agent_graph`,
      );
      await client.query(
        `ALTER TABLE users
           DROP COLUMN IF EXISTS plan,
           DROP COLUMN IF EXISTS subscribed_at,
           DROP COLUMN IF EXISTS expires_at`,
      );
      await client.query(
        `ALTER TABLE user_custom_skills
           DROP COLUMN IF EXISTS content`,
      );
      await client.query(
        `ALTER TABLE skill_bundles
           DROP COLUMN IF EXISTS skill_ids`,
      );
      await client.query(`DROP TABLE IF EXISTS user_plan_subscriptions`);
      await client.query(`DROP TABLE IF EXISTS plans`);
      await client.query(`DROP TABLE IF EXISTS model_provider_configs`);
      await client.query(
        `ALTER TABLE chat_sessions
           DROP CONSTRAINT IF EXISTS fk_chat_sessions_owner_user_id,
           DROP CONSTRAINT IF EXISTS fk_chat_sessions_persona_id,
           DROP COLUMN IF EXISTS owner_user_id,
           DROP COLUMN IF EXISTS persona_id`,
      );
      await client.query(`DROP TABLE IF EXISTS system_settings`);
      await client.query(`DROP TABLE IF EXISTS persona_subscriptions`);
      await client.query(`DROP TABLE IF EXISTS personas`);
    },
  },
  {
    id: '0004_phone_only_user_schema',
    description: '迁移用户表到手机号唯一登录 schema',
    async up(client) {
      await deleteUsersWithoutValidPhone(client);
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'users'
          ) THEN
            ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
            ALTER TABLE users
              ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT false;

            UPDATE users
            SET phone_verified = true
            WHERE phone_verified = false;

            ALTER TABLE users DROP COLUMN IF EXISTS email;
            ALTER TABLE users ALTER COLUMN phone SET NOT NULL;
            ALTER TABLE users ALTER COLUMN phone_verified SET DEFAULT true;
          END IF;
        END $$;
      `);
      await client.query(`DROP INDEX IF EXISTS idx_users_email_unique`);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique ON users(phone)`,
      );
    },
  },
  {
    id: '0005_model_pi_api_schema',
    description: '迁移模型配置 provider 字段到 Pi API schema',
    async up(client) {
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
        DROP CONSTRAINT IF EXISTS chk_official_model_configs_pi_api_valid
      `);
      await client.query(`
        ALTER TABLE user_model_configs
        DROP CONSTRAINT IF EXISTS chk_user_model_configs_pi_api_valid
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
      await client.query(`
        ALTER TABLE official_model_configs
        DROP COLUMN IF EXISTS protocol
      `);
      await client.query(`
        ALTER TABLE user_model_configs
        DROP COLUMN IF EXISTS protocol
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_official_model_configs_pi_api_valid',
        tableName: 'official_model_configs',
        expression: `pi_api IN ('openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai')`,
        cleanupSql: `UPDATE official_model_configs
                     SET pi_api = 'openai-completions'
                     WHERE pi_api NOT IN ('openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_user_model_configs_pi_api_valid',
        tableName: 'user_model_configs',
        expression: `pi_api IN ('openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai')`,
        cleanupSql: `UPDATE user_model_configs
                     SET pi_api = 'openai-completions'
                     WHERE pi_api NOT IN ('openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai')`,
      });
    },
  },
  {
    id: '0006_remove_user_system_skill_preferences',
    description: '移除用户级系统排盘开关和默认启用配置',
    async up(client) {
      await client.query(`DROP TABLE IF EXISTS user_skills`);
      await client.query(`
        ALTER TABLE skill_global_config
          DROP COLUMN IF EXISTS default_enabled
      `);
    },
  },
  {
    id: '0007_user_soul_content',
    description: '增加用户级 Soul 自定义人格配置',
    async up(client) {
      await client.query(`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS soul_content TEXT NOT NULL DEFAULT ''
      `);
    },
  },
  {
    id: '0008_balance_cents_schema',
    description: '将历史 point 列按分余额语义保留',
    async up(client) {
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'purchased_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'purchased_cents') THEN
            ALTER TABLE users RENAME COLUMN purchased_points TO purchased_cents;
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'bonus_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'bonus_cents') THEN
            ALTER TABLE users RENAME COLUMN bonus_points TO bonus_cents;
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'earned_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'earned_cents') THEN
            ALTER TABLE users RENAME COLUMN earned_points TO earned_cents;
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'reserved_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'reserved_cents') THEN
            ALTER TABLE users RENAME COLUMN reserved_points TO reserved_cents;
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'pending_withdrawal_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'pending_withdrawal_cents') THEN
            ALTER TABLE users RENAME COLUMN pending_withdrawal_points TO pending_withdrawal_cents;
          END IF;

          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wallet_transactions' AND column_name = 'amount_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wallet_transactions' AND column_name = 'amount_cents') THEN
            ALTER TABLE wallet_transactions RENAME COLUMN amount_points TO amount_cents;
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wallet_transactions' AND column_name = 'reserved_delta_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wallet_transactions' AND column_name = 'reserved_delta_cents') THEN
            ALTER TABLE wallet_transactions RENAME COLUMN reserved_delta_points TO reserved_delta_cents;
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wallet_transactions' AND column_name = 'point_source')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wallet_transactions' AND column_name = 'balance_source') THEN
            ALTER TABLE wallet_transactions RENAME COLUMN point_source TO balance_source;
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wallet_transactions' AND column_name = 'point_batch_id')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wallet_transactions' AND column_name = 'balance_grant_id') THEN
            ALTER TABLE wallet_transactions RENAME COLUMN point_batch_id TO balance_grant_id;
          END IF;

          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'recharge_orders' AND column_name = 'amount_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'recharge_orders' AND column_name = 'amount_cents') THEN
            ALTER TABLE recharge_orders RENAME COLUMN amount_points TO amount_cents;
          END IF;

          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'monthly_billing_state' AND column_name = 'billed_overage_cost_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'monthly_billing_state' AND column_name = 'billed_overage_cost_cents') THEN
            ALTER TABLE monthly_billing_state RENAME COLUMN billed_overage_cost_points TO billed_overage_cost_cents;
          END IF;

          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'billing_request_reservations' AND column_name = 'reserved_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'billing_request_reservations' AND column_name = 'reserved_cents') THEN
            ALTER TABLE billing_request_reservations RENAME COLUMN reserved_points TO reserved_cents;
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'billing_request_reservations' AND column_name = 'actual_charge_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'billing_request_reservations' AND column_name = 'actual_charge_cents') THEN
            ALTER TABLE billing_request_reservations RENAME COLUMN actual_charge_points TO actual_charge_cents;
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'billing_request_reservations' AND column_name = 'total_overage_cost_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'billing_request_reservations' AND column_name = 'total_overage_cost_cents') THEN
            ALTER TABLE billing_request_reservations RENAME COLUMN total_overage_cost_points TO total_overage_cost_cents;
          END IF;

          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'creator_earnings_monthly' AND column_name = 'gross_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'creator_earnings_monthly' AND column_name = 'gross_cents') THEN
            ALTER TABLE creator_earnings_monthly RENAME COLUMN gross_points TO gross_cents;
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'creator_earnings_monthly' AND column_name = 'platform_cut_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'creator_earnings_monthly' AND column_name = 'platform_cut_cents') THEN
            ALTER TABLE creator_earnings_monthly RENAME COLUMN platform_cut_points TO platform_cut_cents;
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'creator_earnings_monthly' AND column_name = 'net_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'creator_earnings_monthly' AND column_name = 'net_cents') THEN
            ALTER TABLE creator_earnings_monthly RENAME COLUMN net_points TO net_cents;
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'creator_earnings_monthly' AND column_name = 'withdrawn_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'creator_earnings_monthly' AND column_name = 'withdrawn_cents') THEN
            ALTER TABLE creator_earnings_monthly RENAME COLUMN withdrawn_points TO withdrawn_cents;
          END IF;

          IF to_regclass('public.point_batches') IS NOT NULL
             AND to_regclass('public.balance_grants') IS NULL THEN
            ALTER TABLE point_batches RENAME TO balance_grants;
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'balance_grants' AND column_name = 'amount_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'balance_grants' AND column_name = 'amount_cents') THEN
            ALTER TABLE balance_grants RENAME COLUMN amount_points TO amount_cents;
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'balance_grants' AND column_name = 'remaining_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'balance_grants' AND column_name = 'remaining_cents') THEN
            ALTER TABLE balance_grants RENAME COLUMN remaining_points TO remaining_cents;
          END IF;

          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'creator_withdrawals' AND column_name = 'amount_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'creator_withdrawals' AND column_name = 'amount_cents') THEN
            ALTER TABLE creator_withdrawals RENAME COLUMN amount_points TO amount_cents;
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'creator_withdrawals' AND column_name = 'platform_fee_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'creator_withdrawals' AND column_name = 'platform_fee_cents') THEN
            ALTER TABLE creator_withdrawals RENAME COLUMN platform_fee_points TO platform_fee_cents;
          END IF;

          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'official_model_configs' AND column_name = 'input_token_price_per_million_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'official_model_configs' AND column_name = 'input_token_price_per_million_cents') THEN
            ALTER TABLE official_model_configs RENAME COLUMN input_token_price_per_million_points TO input_token_price_per_million_cents;
          END IF;
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'official_model_configs' AND column_name = 'output_token_price_per_million_points')
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'official_model_configs' AND column_name = 'output_token_price_per_million_cents') THEN
            ALTER TABLE official_model_configs RENAME COLUMN output_token_price_per_million_points TO output_token_price_per_million_cents;
          END IF;
        END $$;
      `);
      await client.query(`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS purchased_cents INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS bonus_cents INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS earned_cents INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS reserved_cents INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS pending_withdrawal_cents INTEGER NOT NULL DEFAULT 0
      `);
      await client.query(`
        ALTER TABLE wallet_transactions
          ADD COLUMN IF NOT EXISTS amount_cents INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS reserved_delta_cents INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS balance_source TEXT DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS balance_grant_id TEXT DEFAULT NULL
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_balance_grants_user_active
         ON balance_grants(user_id, expires_at, remaining_cents)
         WHERE status = 'active'`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_balance_grants_expiry_scan
         ON balance_grants(expires_at)
         WHERE status = 'active' AND expires_at IS NOT NULL`,
      );
      await client.query(`DROP INDEX IF EXISTS idx_point_batches_user_active`);
      await client.query(`DROP INDEX IF EXISTS idx_point_batches_expiry_scan`);
    },
  },
  {
    id: '0009_remove_creator_earnings_schema',
    description: '移除创作收益与提现 schema',
    async up(client) {
      await client.query(`DROP TABLE IF EXISTS creator_withdrawals`);
      await client.query(`DROP TABLE IF EXISTS creator_earnings_monthly`);
      await client.query(`
        ALTER TABLE users
          DROP COLUMN IF EXISTS earned_cents,
          DROP COLUMN IF EXISTS pending_withdrawal_cents
      `);
      await client.query(`
        UPDATE wallet_transactions
        SET balance_source = NULL
        WHERE balance_source = 'earned'
      `);
      await client.query(`
        DELETE FROM wallet_transactions
        WHERE kind IN ('creator_revenue', 'withdrawal')
      `);
    },
  },
  {
    id: '0010_daily_sign_in_reward_config',
    description: '增加每日签到软妹币奖励配置和签到记录',
    async up(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS daily_sign_in_config (
          id TEXT PRIMARY KEY DEFAULT 'default',
          enabled BOOLEAN NOT NULL DEFAULT FALSE,
          reward_cents INTEGER NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        INSERT INTO daily_sign_in_config (id)
        VALUES ('default')
        ON CONFLICT (id) DO NOTHING
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS daily_sign_in_records (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          sign_in_date TEXT NOT NULL,
          reward_cents INTEGER NOT NULL DEFAULT 0,
          balance_grant_id TEXT DEFAULT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(user_id, sign_in_date)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_daily_sign_in_records_user_created_at
         ON daily_sign_in_records(user_id, created_at DESC)`,
      );
      await ensureCheckConstraint(client, {
        constraintName: 'chk_daily_sign_in_config_reward_cents_nonnegative',
        tableName: 'daily_sign_in_config',
        expression: 'reward_cents >= 0',
        cleanupSql: `UPDATE daily_sign_in_config
                     SET reward_cents = 0
                     WHERE reward_cents < 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_daily_sign_in_records_reward_cents_nonnegative',
        tableName: 'daily_sign_in_records',
        expression: 'reward_cents >= 0',
        cleanupSql: `UPDATE daily_sign_in_records
                     SET reward_cents = 0
                     WHERE reward_cents < 0`,
      });
    },
  },
  {
    id: '0011_soft_currency_coins_schema',
    description: '迁移余额与充值 schema 到软妹币整数单位',
    async up(client) {
      // 旧 schema 用 cents/yuan 表达金额；本迁移先收敛为整数软妹币，后续迁移再扩展到两位小数。
      await client.query(`
        CREATE OR REPLACE FUNCTION pg_temp.to_soft_currency_coins(value INTEGER)
        RETURNS INTEGER
        LANGUAGE SQL
        IMMUTABLE
        AS $fn$
          SELECT CASE
            WHEN value >= 0 THEN CEIL(value::numeric / 100)::int
            ELSE FLOOR(value::numeric / 100)::int
          END
        $fn$;
      `);
      await client.query(
        `DROP INDEX IF EXISTS idx_balance_grants_user_active`,
      );
      await client.query(`
        ALTER TABLE billing_request_reservations
          DROP CONSTRAINT IF EXISTS chk_billing_request_reservations_reserved_cents_nonnegative,
          DROP CONSTRAINT IF EXISTS chk_billing_request_reservations_actual_charge_cents_nonnegative,
          DROP CONSTRAINT IF EXISTS chk_billing_request_reservations_total_overage_cost_cents_nonnegative;
        ALTER TABLE recharge_payment_config
          DROP CONSTRAINT IF EXISTS chk_recharge_payment_config_min_yuan_positive,
          DROP CONSTRAINT IF EXISTS chk_recharge_payment_config_max_yuan_valid;
        ALTER TABLE recharge_orders
          DROP CONSTRAINT IF EXISTS chk_recharge_orders_amount_cents_positive,
          DROP CONSTRAINT IF EXISTS chk_recharge_orders_amount_yuan_positive;
        ALTER TABLE balance_grants
          DROP CONSTRAINT IF EXISTS chk_balance_grants_remaining_cents_range;
        ALTER TABLE daily_sign_in_config
          DROP CONSTRAINT IF EXISTS chk_daily_sign_in_config_reward_cents_nonnegative;
        ALTER TABLE daily_sign_in_records
          DROP CONSTRAINT IF EXISTS chk_daily_sign_in_records_reward_cents_nonnegative;
      `);
      await client.query(`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS purchased_coins INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS bonus_coins INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS reserved_coins INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE wallet_transactions
          ADD COLUMN IF NOT EXISTS amount_coins INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS reserved_delta_coins INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE recharge_payment_config
          ADD COLUMN IF NOT EXISTS min_coins NUMERIC(12,0) NOT NULL DEFAULT 1,
          ADD COLUMN IF NOT EXISTS max_coins NUMERIC(12,0) NOT NULL DEFAULT 1000;
        ALTER TABLE recharge_orders
          ADD COLUMN IF NOT EXISTS amount_coins INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE monthly_billing_state
          ADD COLUMN IF NOT EXISTS billed_overage_cost_coins INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE billing_request_reservations
          ADD COLUMN IF NOT EXISTS reserved_coins INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS actual_charge_coins INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS total_overage_cost_coins INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE balance_grants
          ADD COLUMN IF NOT EXISTS amount_coins INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS remaining_coins INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE official_model_configs
          ADD COLUMN IF NOT EXISTS input_token_price_per_million_coins INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS output_token_price_per_million_coins INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE daily_sign_in_config
          ADD COLUMN IF NOT EXISTS reward_coins INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE daily_sign_in_records
          ADD COLUMN IF NOT EXISTS reward_coins INTEGER NOT NULL DEFAULT 0;
      `);
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'users'
              AND column_name = 'purchased_cents'
          ) THEN
            UPDATE users
            SET purchased_coins = pg_temp.to_soft_currency_coins(purchased_cents)
            WHERE purchased_coins = 0 AND purchased_cents <> 0;
          END IF;
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'users'
              AND column_name = 'bonus_cents'
          ) THEN
            UPDATE users
            SET bonus_coins = pg_temp.to_soft_currency_coins(bonus_cents)
            WHERE bonus_coins = 0 AND bonus_cents <> 0;
          END IF;
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'users'
              AND column_name = 'reserved_cents'
          ) THEN
            UPDATE users
            SET reserved_coins = pg_temp.to_soft_currency_coins(reserved_cents)
            WHERE reserved_coins = 0 AND reserved_cents <> 0;
          END IF;

          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'wallet_transactions'
              AND column_name = 'amount_cents'
          ) THEN
            UPDATE wallet_transactions
            SET amount_coins = pg_temp.to_soft_currency_coins(amount_cents)
            WHERE amount_coins = 0 AND amount_cents <> 0;
          END IF;
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'wallet_transactions'
              AND column_name = 'reserved_delta_cents'
          ) THEN
            UPDATE wallet_transactions
            SET reserved_delta_coins = pg_temp.to_soft_currency_coins(reserved_delta_cents)
            WHERE reserved_delta_coins = 0 AND reserved_delta_cents <> 0;
          END IF;

          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'recharge_payment_config'
              AND column_name = 'min_yuan'
          ) THEN
            UPDATE recharge_payment_config
            SET min_coins = GREATEST(1, CEIL(min_yuan)::int)
            WHERE min_coins = 1 AND min_yuan <> 1;
          END IF;
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'recharge_payment_config'
              AND column_name = 'max_yuan'
          ) THEN
            UPDATE recharge_payment_config
            SET max_coins = GREATEST(1, CEIL(max_yuan)::int)
            WHERE max_coins = 1000 AND max_yuan <> 1000;
          END IF;

          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'recharge_orders'
              AND column_name = 'amount_cents'
          ) THEN
            UPDATE recharge_orders
            SET amount_coins = pg_temp.to_soft_currency_coins(amount_cents)
            WHERE amount_coins = 0 AND amount_cents <> 0;
          ELSIF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'recharge_orders'
              AND column_name = 'amount_yuan'
          ) THEN
            UPDATE recharge_orders
            SET amount_coins = GREATEST(1, CEIL(amount_yuan)::int)
            WHERE amount_coins = 0 AND amount_yuan > 0;
          END IF;

          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'monthly_billing_state'
              AND column_name = 'billed_overage_cost_cents'
          ) THEN
            UPDATE monthly_billing_state
            SET billed_overage_cost_coins = pg_temp.to_soft_currency_coins(billed_overage_cost_cents)
            WHERE billed_overage_cost_coins = 0
              AND billed_overage_cost_cents <> 0;
          END IF;

          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'billing_request_reservations'
              AND column_name = 'reserved_cents'
          ) THEN
            UPDATE billing_request_reservations
            SET reserved_coins = pg_temp.to_soft_currency_coins(reserved_cents)
            WHERE reserved_coins = 0 AND reserved_cents <> 0;
          END IF;
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'billing_request_reservations'
              AND column_name = 'actual_charge_cents'
          ) THEN
            UPDATE billing_request_reservations
            SET actual_charge_coins = pg_temp.to_soft_currency_coins(actual_charge_cents)
            WHERE actual_charge_coins = 0 AND actual_charge_cents <> 0;
          END IF;
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'billing_request_reservations'
              AND column_name = 'total_overage_cost_cents'
          ) THEN
            UPDATE billing_request_reservations
            SET total_overage_cost_coins = pg_temp.to_soft_currency_coins(total_overage_cost_cents)
            WHERE total_overage_cost_coins = 0
              AND total_overage_cost_cents <> 0;
          END IF;

          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'balance_grants'
              AND column_name = 'amount_cents'
          ) THEN
            UPDATE balance_grants
            SET amount_coins = pg_temp.to_soft_currency_coins(amount_cents)
            WHERE amount_coins = 0 AND amount_cents <> 0;
          END IF;
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'balance_grants'
              AND column_name = 'remaining_cents'
          ) THEN
            UPDATE balance_grants
            SET remaining_coins = pg_temp.to_soft_currency_coins(remaining_cents)
            WHERE remaining_coins = 0 AND remaining_cents <> 0;
          END IF;

          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'official_model_configs'
              AND column_name = 'input_token_price_per_million_cents'
          ) THEN
            UPDATE official_model_configs
            SET input_token_price_per_million_coins =
              pg_temp.to_soft_currency_coins(input_token_price_per_million_cents)
            WHERE input_token_price_per_million_coins = 0
              AND input_token_price_per_million_cents <> 0;
          END IF;
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'official_model_configs'
              AND column_name = 'output_token_price_per_million_cents'
          ) THEN
            UPDATE official_model_configs
            SET output_token_price_per_million_coins =
              pg_temp.to_soft_currency_coins(output_token_price_per_million_cents)
            WHERE output_token_price_per_million_coins = 0
              AND output_token_price_per_million_cents <> 0;
          END IF;

          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'daily_sign_in_config'
              AND column_name = 'reward_cents'
          ) THEN
            UPDATE daily_sign_in_config
            SET reward_coins = pg_temp.to_soft_currency_coins(reward_cents)
            WHERE reward_coins = 0 AND reward_cents <> 0;
          END IF;
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'daily_sign_in_records'
              AND column_name = 'reward_cents'
          ) THEN
            UPDATE daily_sign_in_records
            SET reward_coins = pg_temp.to_soft_currency_coins(reward_cents)
            WHERE reward_coins = 0 AND reward_cents <> 0;
          END IF;
        END $$;
      `);
      await client.query(`
        UPDATE recharge_payment_config
        SET min_coins = GREATEST(1, min_coins),
            max_coins = GREATEST(GREATEST(1, min_coins), max_coins);
        UPDATE recharge_orders
        SET amount_coins = GREATEST(1, amount_coins)
        WHERE amount_coins <= 0;
        UPDATE balance_grants
        SET amount_coins = GREATEST(1, amount_coins),
            remaining_coins = LEAST(
              GREATEST(0, remaining_coins),
              GREATEST(1, amount_coins)
            );
        UPDATE billing_request_reservations
        SET reserved_coins = GREATEST(0, reserved_coins),
            actual_charge_coins = GREATEST(0, actual_charge_coins),
            total_overage_cost_coins = GREATEST(0, total_overage_cost_coins);
        UPDATE daily_sign_in_config
        SET reward_coins = GREATEST(0, reward_coins);
        UPDATE daily_sign_in_records
        SET reward_coins = GREATEST(0, reward_coins);
      `);
      await client.query(`
        ALTER TABLE users
          DROP COLUMN IF EXISTS purchased_cents,
          DROP COLUMN IF EXISTS bonus_cents,
          DROP COLUMN IF EXISTS earned_cents,
          DROP COLUMN IF EXISTS reserved_cents,
          DROP COLUMN IF EXISTS pending_withdrawal_cents;
        ALTER TABLE wallet_transactions
          DROP COLUMN IF EXISTS amount_cents,
          DROP COLUMN IF EXISTS reserved_delta_cents;
        ALTER TABLE recharge_payment_config
          DROP COLUMN IF EXISTS min_yuan,
          DROP COLUMN IF EXISTS max_yuan;
        ALTER TABLE recharge_orders
          DROP COLUMN IF EXISTS amount_yuan,
          DROP COLUMN IF EXISTS amount_cents;
        ALTER TABLE monthly_billing_state
          DROP COLUMN IF EXISTS billed_overage_cost_cents;
        ALTER TABLE billing_request_reservations
          DROP COLUMN IF EXISTS reserved_cents,
          DROP COLUMN IF EXISTS actual_charge_cents,
          DROP COLUMN IF EXISTS total_overage_cost_cents;
        ALTER TABLE balance_grants
          DROP COLUMN IF EXISTS amount_cents,
          DROP COLUMN IF EXISTS remaining_cents;
        ALTER TABLE official_model_configs
          DROP COLUMN IF EXISTS input_token_price_per_million_cents,
          DROP COLUMN IF EXISTS output_token_price_per_million_cents;
        ALTER TABLE daily_sign_in_config
          DROP COLUMN IF EXISTS reward_cents;
        ALTER TABLE daily_sign_in_records
          DROP COLUMN IF EXISTS reward_cents;
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_balance_grants_user_active
         ON balance_grants(user_id, expires_at, remaining_coins)
         WHERE status = 'active'`,
      );
      await ensureCheckConstraint(client, {
        constraintName: 'chk_recharge_payment_config_min_coins_positive',
        tableName: 'recharge_payment_config',
        expression: 'min_coins > 0',
        cleanupSql: `UPDATE recharge_payment_config
                     SET min_coins = 1
                     WHERE min_coins <= 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_recharge_payment_config_max_coins_valid',
        tableName: 'recharge_payment_config',
        expression: 'max_coins >= min_coins',
        cleanupSql: `UPDATE recharge_payment_config
                     SET max_coins = GREATEST(min_coins, 1000)
                     WHERE max_coins < min_coins`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_recharge_orders_amount_coins_positive',
        tableName: 'recharge_orders',
        expression: 'amount_coins > 0',
        cleanupSql: `UPDATE recharge_orders
                     SET amount_coins = 1
                     WHERE amount_coins <= 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_billing_request_reservations_reserved_coins_nonnegative',
        tableName: 'billing_request_reservations',
        expression: 'reserved_coins >= 0',
        cleanupSql: `UPDATE billing_request_reservations
                     SET reserved_coins = 0
                     WHERE reserved_coins < 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName:
          'chk_billing_request_reservations_actual_charge_coins_nonnegative',
        tableName: 'billing_request_reservations',
        expression: 'actual_charge_coins >= 0',
        cleanupSql: `UPDATE billing_request_reservations
                     SET actual_charge_coins = 0
                     WHERE actual_charge_coins < 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName:
          'chk_billing_request_reservations_total_overage_cost_coins_nonnegative',
        tableName: 'billing_request_reservations',
        expression: 'total_overage_cost_coins >= 0',
        cleanupSql: `UPDATE billing_request_reservations
                     SET total_overage_cost_coins = 0
                     WHERE total_overage_cost_coins < 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_balance_grants_remaining_coins_range',
        tableName: 'balance_grants',
        expression:
          'amount_coins > 0 AND remaining_coins >= 0 AND remaining_coins <= amount_coins',
        cleanupSql: `UPDATE balance_grants
                     SET amount_coins = GREATEST(1, amount_coins),
                         remaining_coins = LEAST(GREATEST(1, amount_coins), GREATEST(remaining_coins, 0))
                     WHERE amount_coins <= 0
                        OR remaining_coins < 0
                        OR remaining_coins > amount_coins`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_daily_sign_in_config_reward_coins_nonnegative',
        tableName: 'daily_sign_in_config',
        expression: 'reward_coins >= 0',
        cleanupSql: `UPDATE daily_sign_in_config
                     SET reward_coins = 0
                     WHERE reward_coins < 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_daily_sign_in_records_reward_coins_nonnegative',
        tableName: 'daily_sign_in_records',
        expression: 'reward_coins >= 0',
        cleanupSql: `UPDATE daily_sign_in_records
                     SET reward_coins = 0
                     WHERE reward_coins < 0`,
      });
    },
  },
  {
    id: '0012_model_billing_config',
    description: '增加模型平台服务费配置',
    async up(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS model_billing_config (
          id TEXT PRIMARY KEY DEFAULT 'default',
          custom_model_platform_price_per_million_coins INTEGER NOT NULL DEFAULT 2,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        INSERT INTO model_billing_config (
          id, custom_model_platform_price_per_million_coins
        )
        VALUES ('default', 2)
        ON CONFLICT (id) DO NOTHING
      `);
      await ensureCheckConstraint(client, {
        constraintName:
          'chk_model_billing_config_custom_platform_price_nonnegative',
        tableName: 'model_billing_config',
        expression: 'custom_model_platform_price_per_million_coins >= 0',
        cleanupSql: `UPDATE model_billing_config
                     SET custom_model_platform_price_per_million_coins = 0
                     WHERE custom_model_platform_price_per_million_coins < 0`,
      });
    },
  },
  {
    id: '0013_soft_currency_decimal_scale',
    description: '软妹币金额字段支持两位小数',
    async up(client) {
      await client.query(`
        ALTER TABLE monthly_billing_state
          DROP CONSTRAINT IF EXISTS chk_monthly_billing_state_billed_overage_cost_microcoins_nonnegative;
        ALTER TABLE billing_request_reservations
          DROP CONSTRAINT IF EXISTS chk_billing_request_reservations_total_overage_cost_microcoins_nonnegative;
        ALTER TABLE monthly_billing_state
          DROP COLUMN IF EXISTS billed_overage_cost_microcoins;
        ALTER TABLE billing_request_reservations
          DROP COLUMN IF EXISTS total_overage_cost_microcoins;
      `);
      await client.query(`
        ALTER TABLE users
          ALTER COLUMN purchased_coins TYPE NUMERIC(14,2) USING ROUND(purchased_coins::numeric, 2),
          ALTER COLUMN bonus_coins TYPE NUMERIC(14,2) USING ROUND(bonus_coins::numeric, 2),
          ALTER COLUMN reserved_coins TYPE NUMERIC(14,2) USING ROUND(reserved_coins::numeric, 2);
        ALTER TABLE wallet_transactions
          ALTER COLUMN amount_coins TYPE NUMERIC(14,2) USING ROUND(amount_coins::numeric, 2),
          ALTER COLUMN reserved_delta_coins TYPE NUMERIC(14,2) USING ROUND(reserved_delta_coins::numeric, 2);
        ALTER TABLE recharge_payment_config
          ALTER COLUMN min_coins TYPE NUMERIC(14,2) USING ROUND(min_coins::numeric, 2),
          ALTER COLUMN max_coins TYPE NUMERIC(14,2) USING ROUND(max_coins::numeric, 2);
        ALTER TABLE recharge_orders
          ALTER COLUMN amount_coins TYPE NUMERIC(14,2) USING ROUND(amount_coins::numeric, 2);
        ALTER TABLE monthly_billing_state
          ALTER COLUMN billed_overage_cost_coins TYPE NUMERIC(14,2) USING ROUND(billed_overage_cost_coins::numeric, 2);
        ALTER TABLE billing_request_reservations
          ALTER COLUMN reserved_coins TYPE NUMERIC(14,2) USING ROUND(reserved_coins::numeric, 2),
          ALTER COLUMN actual_charge_coins TYPE NUMERIC(14,2) USING ROUND(actual_charge_coins::numeric, 2),
          ALTER COLUMN total_overage_cost_coins TYPE NUMERIC(14,2) USING ROUND(total_overage_cost_coins::numeric, 2);
        ALTER TABLE balance_grants
          ALTER COLUMN amount_coins TYPE NUMERIC(14,2) USING ROUND(amount_coins::numeric, 2),
          ALTER COLUMN remaining_coins TYPE NUMERIC(14,2) USING ROUND(remaining_coins::numeric, 2);
        ALTER TABLE daily_sign_in_config
          ALTER COLUMN reward_coins TYPE NUMERIC(14,2) USING ROUND(reward_coins::numeric, 2);
        ALTER TABLE daily_sign_in_records
          ALTER COLUMN reward_coins TYPE NUMERIC(14,2) USING ROUND(reward_coins::numeric, 2);
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_users_reserved_coins_nonnegative',
        tableName: 'users',
        expression: 'reserved_coins >= 0',
        cleanupSql: `UPDATE users
                     SET reserved_coins = 0
                     WHERE reserved_coins < 0`,
      });
    },
  },
  {
    id: '0014_daily_usage_total_tokens',
    description: '为每日用量增加 Pi total token 统计列',
    async up(client) {
      await client.query(`
        ALTER TABLE daily_usage
          ADD COLUMN IF NOT EXISTS total_tokens INTEGER DEFAULT 0;

        WITH resolved_log_usage AS (
          SELECT COALESCE(
                   a.owner_id,
                   NULLIF(REGEXP_REPLACE(l.account_id, '^web:', ''), l.account_id)
                 ) AS user_id,
                 to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
                 COALESCE((l.usage->>'totalTokens')::integer, 0) AS total_tokens
          FROM conversation_logs l
          LEFT JOIN accounts a ON a.id = l.account_id
          WHERE l.usage ? 'totalTokens'
        ),
        log_usage AS (
          SELECT r.user_id, r.date, SUM(r.total_tokens) AS total_tokens
          FROM resolved_log_usage r
          JOIN users u ON u.id = r.user_id
          GROUP BY r.user_id, r.date
        )
        INSERT INTO daily_usage (
          user_id, date, msg_count, input_tokens, output_tokens, total_tokens
        )
        SELECT user_id, date, 0, 0, 0, total_tokens
        FROM log_usage
        WHERE total_tokens > 0
        ON CONFLICT (user_id, date) DO UPDATE SET
          total_tokens = GREATEST(
            COALESCE(daily_usage.total_tokens, 0),
            EXCLUDED.total_tokens
          );

        UPDATE daily_usage
        SET total_tokens = GREATEST(
          COALESCE(total_tokens, 0),
          COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
        )
        WHERE total_tokens IS NULL
          OR COALESCE(total_tokens, 0) < COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0);

        ALTER TABLE daily_usage
          ALTER COLUMN total_tokens SET DEFAULT 0;
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_daily_usage_total_tokens_nonnegative',
        tableName: 'daily_usage',
        expression: 'total_tokens >= 0',
        cleanupSql: `UPDATE daily_usage
                     SET total_tokens = GREATEST(0, input_tokens + output_tokens)
                     WHERE total_tokens < 0`,
      });
    },
  },
  {
    id: '0015_public_financial_ledger',
    description: '增加关于页面公开收支流水',
    async up(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS public_financial_ledger_entries (
          id TEXT PRIMARY KEY,
          entry_type TEXT NOT NULL,
          occurred_at DATE NOT NULL,
          content TEXT NOT NULL,
          amount_yuan NUMERIC(14,2) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_public_financial_ledger_entry_type_valid',
        tableName: 'public_financial_ledger_entries',
        expression: "entry_type IN ('income', 'expense')",
        cleanupSql: `UPDATE public_financial_ledger_entries
                     SET entry_type = 'expense'
                     WHERE entry_type NOT IN ('income', 'expense')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_public_financial_ledger_amount_yuan_positive',
        tableName: 'public_financial_ledger_entries',
        expression: 'amount_yuan > 0',
        cleanupSql: `UPDATE public_financial_ledger_entries
                     SET amount_yuan = 1
                     WHERE amount_yuan <= 0`,
      });
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_public_financial_ledger_occurred_at
          ON public_financial_ledger_entries (occurred_at DESC, created_at DESC)
      `);
      await client.query(`
        INSERT INTO public_financial_ledger_entries (
          id, entry_type, occurred_at, content, amount_yuan
        )
        VALUES
          ('public-ledger-seed-server-cost', 'expense', CURRENT_DATE, '服务器成本', 500),
          ('public-ledger-seed-domain-cost', 'expense', CURRENT_DATE, '域名成本', 100),
          ('public-ledger-seed-development-cost', 'expense', CURRENT_DATE, '开发成本', 300)
        ON CONFLICT (id) DO NOTHING
      `);
    },
  },
  {
    id: '0016_remove_skill_paid_schema',
    description: '移除 Skill 付费档位与创作者整包付费 schema',
    async up(client) {
      await client.query(`
        DROP INDEX IF EXISTS idx_bundle_sub_subscriber_active_expiry;
        DROP INDEX IF EXISTS idx_bundle_sub_creator;
        DROP INDEX IF EXISTS idx_bundle_sub_subscriber;

        DROP TABLE IF EXISTS creator_bundle_config;
        DROP TABLE IF EXISTS creator_bundle_subscriptions;

        ALTER TABLE user_custom_skills
          DROP COLUMN IF EXISTS price_tiers;

        ALTER TABLE user_skill_subscriptions
          DROP COLUMN IF EXISTS tier_key;
      `);
    },
  },
];

const MIGRATION_LOCK_KEY = [708527, 1];

async function ensureMigrationTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function runDatabaseMigrations(
  client: pg.PoolClient,
): Promise<void> {
  // 多实例启动时串行执行迁移，避免 schema_migrations 唯一键竞争导致启动失败。
  await client.query('SELECT pg_advisory_lock($1, $2)', MIGRATION_LOCK_KEY);
  try {
    await ensureMigrationTable(client);

    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM schema_migrations',
    );
    const appliedIds = new Set(rows.map((row) => row.id));

    for (const migration of MIGRATIONS) {
      if (appliedIds.has(migration.id)) continue;

      await client.query('BEGIN');
      try {
        await migration.up(client);
        await client.query(
          `INSERT INTO schema_migrations (id, description)
           VALUES ($1, $2)`,
          [migration.id, migration.description],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1, $2)', MIGRATION_LOCK_KEY);
  }
}
