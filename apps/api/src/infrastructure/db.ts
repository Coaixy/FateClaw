import crypto from 'node:crypto';
import pg from 'pg';

import {
  DATABASE_URL,
  JWT_SECRET,
  PLATFORM_CUT_PERCENT,
  WITHDRAWAL_ENCRYPTION_KEY,
} from './config.js';
import { logger } from './logger.js';
import { getRedis } from './redis.js';
import { buildConversationCapabilityLedger } from '../modules/conversation-log/capability-ledger.js';
import {
  deleteUsersWithoutValidPhone,
  enforcePhoneOnlyUsers,
} from './phone-only-user-migration.js';
import {
  Account,
  ChatSession,
  ConfigAuditLog,
  CreatorEarningsMonthly,
  EffectiveUserSkill,
  ModelProviderType,
  NewMessage,
  OfficialModelConfig,
  PointBatchSource,
  ScheduledTask,
  SystemSecretRow,
  SkillBundle,
  TaskRunLog,
  User,
  UserCustomSkill,
  UserModelConfig,
  UserModelSelection,
  UserRole,
  UserSkill,
  UserSkillSubscription,
} from '../shared/types.js';
import {
  assertSufficientSpendablePoints,
  calculateAvailableSpendablePoints,
} from '../shared/point-balance.js';

/** Redis 中每个账号保留的最大历史消息条数。 */
const HISTORY_REDIS_MAX = 500;

const { Pool } = pg;

let pool: pg.Pool;

type DbQueryable = pg.Pool | pg.PoolClient;
type JsonObject = Record<string, unknown>;

export function getDbPool(): pg.Pool {
  if (!pool) {
    throw new Error('数据库未初始化');
  }
  return pool;
}

const USER_SELECT_COLUMNS = `
  u.id,
  u.phone,
  u.phone_verified,
  u.password_hash,
  u.role,
  u.purchased_points,
  u.bonus_points,
  u.earned_points,
  u.reserved_points,
  u.pending_withdrawal_points,
  u.created_at
`;

const USER_CUSTOM_SKILL_SELECT_COLUMNS = `
  s.id,
  s.user_id,
  s.skill_name,
  s.dir_name,
  s.description,
  s.trigger_hint,
  COALESCE(sc.content, '') AS content,
  s.category,
  s.category_normalized,
  s.match_keywords,
  s.match_patterns,
  s.example_queries,
  s.priority,
  s.usage_mode,
  s.visibility,
  s.share_token,
  s.enabled,
  s.price_tiers,
  s.stat_subscriber_count,
  s.stat_view_count,
  s.created_at,
  s.updated_at,
  s.deleted_at
`;

const SKILL_BUNDLE_SELECT_COLUMNS = `
  b.id,
  b.user_id,
  b.name,
  b.description,
  COALESCE(
    (
      SELECT array_agg(sbi.skill_id ORDER BY sbi.sort_order)
      FROM skill_bundle_items sbi
      WHERE sbi.bundle_id = b.id
    ),
    ARRAY[]::text[]
  ) AS skill_ids,
  b.bundle_token,
  b.visibility,
  b.created_at,
  b.updated_at,
  b.deleted_at
`;

async function getUserByIdUsing(
  queryable: DbQueryable,
  id: string,
  opts?: { forUpdate?: boolean },
): Promise<User | undefined> {
  const forUpdateClause = opts?.forUpdate ? ' FOR UPDATE OF u' : '';
  const { rows } = await queryable.query(
    `SELECT ${USER_SELECT_COLUMNS}
     FROM users u
     WHERE u.id = $1${forUpdateClause}`,
    [id],
  );
  return rows[0] as User | undefined;
}

async function getUserByPhoneUsing(
  queryable: DbQueryable,
  phone: string,
): Promise<User | undefined> {
  const { rows } = await queryable.query(
    `SELECT ${USER_SELECT_COLUMNS}
     FROM users u
     WHERE u.phone = $1`,
    [phone],
  );
  return rows[0] as User | undefined;
}

async function getActiveUserSkillSubscriptionIdUsing(
  queryable: DbQueryable,
  subscriberId: string,
  skillId: string,
): Promise<string | null> {
  const { rows } = await queryable.query(
    `SELECT id
     FROM user_skill_subscriptions
     WHERE subscriber_id = $1
       AND skill_id = $2
       AND status = 'active'
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [subscriberId, skillId],
  );
  return (rows[0] as { id?: string } | undefined)?.id ?? null;
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

function toJsonObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

export async function initDatabase(): Promise<void> {
  if (!DATABASE_URL) {
    throw new Error('缺少 DATABASE_URL 环境变量');
  }

  pool = new Pool({ connectionString: DATABASE_URL });

  // 验证连接
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    await deleteUsersWithoutValidPhone(client);
    await enforcePhoneOnlyUsers(client);
    // 确保官方 Skill 全局配置表存在（兼容早于此特性的数据库）
    await client.query(`
      CREATE TABLE IF NOT EXISTS skill_global_config (
        skill_name TEXT PRIMARY KEY,
        globally_enabled BOOLEAN NOT NULL DEFAULT true,
        default_enabled BOOLEAN NOT NULL DEFAULT true,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by TEXT DEFAULT NULL
      )
    `);
    // 兼容：已有表可能缺少 default_enabled 列
    await client.query(`
      ALTER TABLE skill_global_config ADD COLUMN IF NOT EXISTS default_enabled BOOLEAN NOT NULL DEFAULT true
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
        protocol TEXT NOT NULL,
        display_name TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        priority INTEGER NOT NULL DEFAULT 0,
        base_url TEXT DEFAULT NULL,
        model_name TEXT NOT NULL,
        api_key_secret_key TEXT DEFAULT NULL,
        input_token_price_per_million_points INTEGER NOT NULL DEFAULT 0,
        output_token_price_per_million_points INTEGER NOT NULL DEFAULT 0,
        extra_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_model_configs (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        protocol TEXT NOT NULL,
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
      DROP CONSTRAINT IF EXISTS chk_official_model_configs_protocol_valid
    `);
    await client.query(`
      ALTER TABLE user_model_configs
      DROP CONSTRAINT IF EXISTS chk_user_model_configs_protocol_valid
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
              id, model_key, protocol, display_name, enabled, priority,
              base_url, model_name, api_key_secret_key, extra_json,
              created_at, updated_at
            )
          SELECT
            id,
            provider_key,
            provider_type,
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
      SET protocol = 'openai-compatible'
      WHERE protocol = 'openai'
    `);
    await client.query(`
      UPDATE user_model_configs
      SET protocol = 'openai-compatible'
      WHERE protocol = 'openai'
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
      constraintName: 'chk_official_model_configs_protocol_valid',
      tableName: 'official_model_configs',
      expression: `protocol IN ('openai-compatible', 'openai-response', 'anthropic', 'gemini')`,
      cleanupSql: `UPDATE official_model_configs
                   SET protocol = 'openai-compatible'
                   WHERE protocol = 'openai';
                   UPDATE official_model_configs
                   SET protocol = 'openai-compatible'
                   WHERE protocol NOT IN ('openai-compatible', 'openai-response', 'anthropic', 'gemini')`,
    });
    await ensureCheckConstraint(client, {
      constraintName: 'chk_user_model_configs_protocol_valid',
      tableName: 'user_model_configs',
      expression: `protocol IN ('openai-compatible', 'openai-response', 'anthropic', 'gemini')`,
      cleanupSql: `UPDATE user_model_configs
                   SET protocol = 'openai-compatible'
                   WHERE protocol = 'openai';
                   UPDATE user_model_configs
                   SET protocol = 'openai-compatible'
                   WHERE protocol NOT IN ('openai-compatible', 'openai-response', 'anthropic', 'gemini')`,
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
        trigger_hint TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '通用',
        visibility TEXT NOT NULL DEFAULT 'private',
        share_token TEXT UNIQUE,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ DEFAULT NULL,
        UNIQUE(user_id, dir_name)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_custom_skill_contents (
        skill_id TEXT PRIMARY KEY REFERENCES user_custom_skills(id) ON DELETE CASCADE,
        content TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // 增量迁移：为已存在的表添加 category 列
    await client.query(
      `ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT '通用'`,
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
      `ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS category_normalized TEXT`,
    );
    await client.query(
      `ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS match_keywords JSONB NOT NULL DEFAULT '[]'`,
    );
    await client.query(
      `ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS match_patterns JSONB NOT NULL DEFAULT '[]'`,
    );
    await client.query(
      `ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS example_queries JSONB NOT NULL DEFAULT '[]'`,
    );
    await client.query(
      `ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0`,
    );
    await client.query(
      `ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS usage_mode TEXT NOT NULL DEFAULT 'reference_only'`,
    );
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
    await client.query(`DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'user_custom_skills' AND column_name = 'content'
        ) THEN
          INSERT INTO user_custom_skill_contents (skill_id, content, updated_at)
          SELECT id, COALESCE(content, ''), NOW()
          FROM user_custom_skills
          ON CONFLICT (skill_id) DO UPDATE SET
            content = EXCLUDED.content,
            updated_at = NOW();
        END IF;
      END $$;`);
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
      `CREATE INDEX IF NOT EXISTS idx_ucs_market_category_listing
       ON user_custom_skills(category, stat_subscriber_count DESC, created_at DESC)
       WHERE deleted_at IS NULL AND visibility = 'shared'`,
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
        amount_points INTEGER NOT NULL DEFAULT 0,
        reserved_delta_points INTEGER NOT NULL DEFAULT 0,
        point_source TEXT DEFAULT NULL,
        point_batch_id TEXT DEFAULT NULL,
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
        amount_points INTEGER NOT NULL,
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
        billed_overage_cost_points INTEGER NOT NULL DEFAULT 0,
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
        reserved_points INTEGER NOT NULL DEFAULT 0,
        hold_state TEXT NOT NULL DEFAULT 'none',
        charge_state TEXT NOT NULL DEFAULT 'pending',
        actual_charge_points INTEGER NOT NULL DEFAULT 0,
        total_overage_tokens INTEGER NOT NULL DEFAULT 0,
        total_overage_cost_points INTEGER NOT NULL DEFAULT 0,
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
        gross_points INTEGER NOT NULL DEFAULT 0,
        platform_cut_points INTEGER NOT NULL DEFAULT 0,
        net_points INTEGER NOT NULL DEFAULT 0,
        withdrawn_points INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (creator_id, year_month)
      )
    `);

    // ─── 为老库补齐积分相关列 ────────────────────────────────
    // CREATE TABLE IF NOT EXISTS 对已存在的表是 no-op，所以依赖 ALTER ADD COLUMN
    // IF NOT EXISTS 把新列补到历史表上。新环境这些语句全部 no-op。

    // users 三段式积分 + 提现冻结
    await client.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS purchased_points INTEGER NOT NULL DEFAULT 0`,
    );
    await client.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_points INTEGER NOT NULL DEFAULT 0`,
    );
    await client.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS earned_points INTEGER NOT NULL DEFAULT 0`,
    );
    await client.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS reserved_points INTEGER NOT NULL DEFAULT 0`,
    );
    await client.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_withdrawal_points INTEGER NOT NULL DEFAULT 0`,
    );

    // wallet_transactions 积分字段
    await client.query(
      `ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS amount_points INTEGER NOT NULL DEFAULT 0`,
    );
    await client.query(
      `ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS reserved_delta_points INTEGER NOT NULL DEFAULT 0`,
    );
    await client.query(
      `ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS point_source TEXT DEFAULT NULL`,
    );
    await client.query(
      `ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS point_batch_id TEXT DEFAULT NULL`,
    );

    // billing_request_reservations 积分字段
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
      `ALTER TABLE billing_request_reservations ADD COLUMN IF NOT EXISTS reserved_points INTEGER NOT NULL DEFAULT 0`,
    );
    await client.query(
      `ALTER TABLE billing_request_reservations ADD COLUMN IF NOT EXISTS actual_charge_points INTEGER NOT NULL DEFAULT 0`,
    );
    await client.query(
      `ALTER TABLE billing_request_reservations ADD COLUMN IF NOT EXISTS total_overage_cost_points INTEGER NOT NULL DEFAULT 0`,
    );

    // monthly_billing_state 积分版防重扣
    await client.query(
      `ALTER TABLE monthly_billing_state ADD COLUMN IF NOT EXISTS billed_overage_cost_points INTEGER NOT NULL DEFAULT 0`,
    );

    // creator_earnings_monthly 积分版
    await client.query(
      `ALTER TABLE creator_earnings_monthly ADD COLUMN IF NOT EXISTS gross_points INTEGER NOT NULL DEFAULT 0`,
    );
    await client.query(
      `ALTER TABLE creator_earnings_monthly ADD COLUMN IF NOT EXISTS platform_cut_points INTEGER NOT NULL DEFAULT 0`,
    );
    await client.query(
      `ALTER TABLE creator_earnings_monthly ADD COLUMN IF NOT EXISTS net_points INTEGER NOT NULL DEFAULT 0`,
    );
    await client.query(
      `ALTER TABLE creator_earnings_monthly ADD COLUMN IF NOT EXISTS withdrawn_points INTEGER NOT NULL DEFAULT 0`,
    );

    // point_batches：赠送积分批次（FIFO 扣减 + 过期管理）
    await client.query(`
      CREATE TABLE IF NOT EXISTS point_batches (
        id               TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL REFERENCES users(id),
        source           TEXT NOT NULL,
        granted_by       TEXT DEFAULT NULL,
        amount_points    INTEGER NOT NULL CHECK (amount_points > 0),
        remaining_points INTEGER NOT NULL,
        note             TEXT DEFAULT NULL,
        expires_at       TIMESTAMPTZ DEFAULT NULL,
        status           TEXT NOT NULL DEFAULT 'active',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_point_batches_user_active
       ON point_batches(user_id, expires_at, remaining_points)
       WHERE status = 'active'`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_point_batches_expiry_scan
       ON point_batches(expires_at)
       WHERE status = 'active' AND expires_at IS NOT NULL`,
    );

    // creator_withdrawals：创作者提现申请（独立于消费钱包）
    await client.query(`
      CREATE TABLE IF NOT EXISTS creator_withdrawals (
        id                   TEXT PRIMARY KEY,
        creator_id           TEXT NOT NULL REFERENCES users(id),
        amount_points        INTEGER NOT NULL CHECK (amount_points > 0),
        amount_yuan          NUMERIC(12,2) NOT NULL,
        status               TEXT NOT NULL DEFAULT 'pending',
        bank_name            TEXT DEFAULT NULL,
        bank_account         TEXT DEFAULT NULL,
        account_name         TEXT DEFAULT NULL,
        id_number            TEXT DEFAULT NULL,
        tax_type             TEXT DEFAULT NULL,
        company_name         TEXT DEFAULT NULL,
        tax_id               TEXT DEFAULT NULL,
        platform_fee_points  INTEGER NOT NULL DEFAULT 0,
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
    // usage_mode 已从三档收敛为两档，需要先移除旧约束再清洗历史数据。
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
      END $$;
    `);
    await ensureCheckConstraint(client, {
      constraintName: 'chk_user_custom_skills_usage_mode_valid',
      tableName: 'user_custom_skills',
      expression: `usage_mode IN ('force_injected', 'reference_only')`,
      cleanupSql: `UPDATE user_custom_skills
                   SET usage_mode = CASE
                     WHEN usage_mode IN ('routing_override', 'interpretation_rule')
                       THEN 'force_injected'
                     WHEN usage_mode NOT IN ('force_injected', 'reference_only')
                       THEN 'reference_only'
                     ELSE usage_mode
                   END
                   WHERE usage_mode IN ('routing_override', 'interpretation_rule')
                      OR usage_mode NOT IN ('force_injected', 'reference_only')`,
    });
    await ensureCheckConstraint(client, {
      constraintName: 'chk_user_custom_skills_priority_nonnegative',
      tableName: 'user_custom_skills',
      expression: 'priority >= 0',
      cleanupSql: `UPDATE user_custom_skills
                   SET priority = 0
                   WHERE priority < 0`,
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
        'chk_billing_request_reservations_reserved_points_nonnegative',
      tableName: 'billing_request_reservations',
      expression: 'reserved_points >= 0',
      cleanupSql: `UPDATE billing_request_reservations
                   SET reserved_points = 0
                   WHERE reserved_points < 0`,
    });
    await ensureCheckConstraint(client, {
      constraintName:
        'chk_billing_request_reservations_actual_charge_points_nonnegative',
      tableName: 'billing_request_reservations',
      expression: 'actual_charge_points >= 0',
      cleanupSql: `UPDATE billing_request_reservations
                   SET actual_charge_points = 0
                   WHERE actual_charge_points < 0`,
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
        'chk_billing_request_reservations_total_overage_cost_points_nonnegative',
      tableName: 'billing_request_reservations',
      expression: 'total_overage_cost_points >= 0',
      cleanupSql: `UPDATE billing_request_reservations
                   SET total_overage_cost_points = 0
                   WHERE total_overage_cost_points < 0`,
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
      constraintName: 'chk_recharge_orders_amount_points_positive',
      tableName: 'recharge_orders',
      expression: 'amount_points > 0',
      cleanupSql: `UPDATE recharge_orders
                   SET amount_points = 1
                   WHERE amount_points <= 0`,
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
      constraintName: 'chk_point_batches_status_valid',
      tableName: 'point_batches',
      expression: `status IN ('active', 'exhausted', 'expired', 'revoked')`,
      cleanupSql: `UPDATE point_batches
                   SET status = 'active'
                   WHERE status NOT IN ('active', 'exhausted', 'expired', 'revoked')`,
    });
    await ensureCheckConstraint(client, {
      constraintName: 'chk_point_batches_remaining_points_range',
      tableName: 'point_batches',
      expression: 'remaining_points >= 0 AND remaining_points <= amount_points',
      cleanupSql: `UPDATE point_batches
                   SET remaining_points = LEAST(amount_points, GREATEST(remaining_points, 0))
                   WHERE remaining_points < 0 OR remaining_points > amount_points`,
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
      constraintName: 'chk_creator_withdrawals_platform_fee_points_nonnegative',
      tableName: 'creator_withdrawals',
      expression: 'platform_fee_points >= 0',
      cleanupSql: `UPDATE creator_withdrawals
                   SET platform_fee_points = 0
                   WHERE platform_fee_points < 0`,
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

    // ─── 历史迁移：把旧 *_cents 列的值搬到 *_points（幂等） ─────
    // 仅在 *_cents 列还存在且 *_points 未初始化时执行，用 to_regclass 兜底防止
    // 列不存在报错。这段代码在下方 DROP COLUMN 之前必须成功。
    await client.query(`DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'balance_cents'
        ) THEN
          UPDATE users
            SET purchased_points = balance_cents,
                reserved_points  = reserved_balance_cents
          WHERE purchased_points = 0
            AND reserved_points = 0
            AND (balance_cents > 0 OR reserved_balance_cents > 0);
        END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'wallet_transactions' AND column_name = 'amount_cents'
        ) THEN
          UPDATE wallet_transactions
            SET amount_points = amount_cents,
                reserved_delta_points = reserved_delta_cents
          WHERE amount_points = 0
            AND reserved_delta_points = 0
            AND (amount_cents <> 0 OR reserved_delta_cents <> 0);
        END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'billing_request_reservations' AND column_name = 'reserved_cents'
        ) THEN
          UPDATE billing_request_reservations
            SET reserved_points = reserved_cents,
                actual_charge_points = actual_charge_cents,
                total_overage_cost_points = total_overage_cost_cents
          WHERE reserved_points = 0
            AND actual_charge_points = 0
            AND total_overage_cost_points = 0
            AND (reserved_cents > 0 OR actual_charge_cents > 0 OR total_overage_cost_cents > 0);
        END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'monthly_billing_state' AND column_name = 'billed_overage_cost_cents'
        ) THEN
          UPDATE monthly_billing_state
            SET billed_overage_cost_points = billed_overage_cost_cents
          WHERE billed_overage_cost_points = 0
            AND billed_overage_cost_cents > 0;
        END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'creator_earnings_monthly' AND column_name = 'gross_cents'
        ) THEN
          UPDATE creator_earnings_monthly
            SET gross_points = gross_cents,
                platform_cut_points = platform_cut_cents,
                net_points = net_cents,
                withdrawn_points = withdrawn_cents
          WHERE gross_points = 0
            AND platform_cut_points = 0
            AND net_points = 0
            AND withdrawn_points = 0
            AND (gross_cents > 0 OR platform_cut_cents > 0 OR net_cents > 0 OR withdrawn_cents > 0);
        END IF;
      END $$;`);

    // ─── 清理：DROP 旧 *_cents 列（幂等） ─────────────────────
    await client.query(
      `ALTER TABLE users
         DROP COLUMN IF EXISTS balance_cents,
         DROP COLUMN IF EXISTS reserved_balance_cents`,
    );
    await client.query(
      `ALTER TABLE wallet_transactions
         DROP COLUMN IF EXISTS amount_cents,
         DROP COLUMN IF EXISTS reserved_delta_cents`,
    );
    await client.query(
      `ALTER TABLE billing_request_reservations
         DROP COLUMN IF EXISTS reserved_cents,
         DROP COLUMN IF EXISTS actual_charge_cents,
         DROP COLUMN IF EXISTS total_overage_cost_cents`,
    );
    await client.query(
      `ALTER TABLE monthly_billing_state
         DROP COLUMN IF EXISTS billed_overage_cost_cents`,
    );
    await client.query(
      `ALTER TABLE creator_earnings_monthly
         DROP COLUMN IF EXISTS gross_cents,
         DROP COLUMN IF EXISTS platform_cut_cents,
         DROP COLUMN IF EXISTS net_cents,
         DROP COLUMN IF EXISTS withdrawn_cents`,
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
  } finally {
    client.release();
  }
}

/** @internal - for tests only. */
export async function _initTestDatabase(): Promise<void> {
  // Tests should use a real PG database or a mock
  await initDatabase();
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
  }
}

/**
 * 验证 Postgres 连接可用。readiness probe 用，超时由调用方控制。
 */
export async function pingDatabase(): Promise<void> {
  await pool.query('SELECT 1');
}

// =====================
// --- Account accessors ---
// =====================

export async function createAccount(account: Account): Promise<void> {
  await pool.query(
    `INSERT INTO accounts (id, user_id, name, bot_token, base_url, get_updates_buf, enabled, created_at, owner_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      account.id,
      account.user_id,
      account.name,
      account.bot_token,
      account.base_url,
      account.get_updates_buf,
      account.enabled,
      account.created_at,
      account.owner_id ?? null,
    ],
  );
}

export async function getAccount(id: string): Promise<Account | undefined> {
  const { rows } = await pool.query('SELECT * FROM accounts WHERE id = $1', [
    id,
  ]);
  return rows[0] as Account | undefined;
}

export async function getAllAccounts(): Promise<Account[]> {
  const { rows } = await pool.query(
    'SELECT * FROM accounts ORDER BY created_at',
  );
  return rows as Account[];
}

export async function getEnabledAccounts(): Promise<Account[]> {
  const { rows } = await pool.query(
    'SELECT * FROM accounts WHERE enabled = true ORDER BY created_at',
  );
  return rows as Account[];
}

export async function getSoulContent(accountId: string): Promise<string> {
  const { rows } = await pool.query(
    'SELECT soul_content FROM accounts WHERE id = $1',
    [accountId],
  );
  return (rows[0] as { soul_content: string } | undefined)?.soul_content ?? '';
}

export async function updateSoulContent(
  accountId: string,
  content: string,
): Promise<void> {
  await pool.query('UPDATE accounts SET soul_content = $1 WHERE id = $2', [
    content,
    accountId,
  ]);
}

export async function updateAccount(
  id: string,
  updates: Partial<
    Pick<
      Account,
      'name' | 'bot_token' | 'base_url' | 'get_updates_buf' | 'enabled'
    >
  >,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (updates.name !== undefined) {
    fields.push(`name = $${paramIdx++}`);
    values.push(updates.name);
  }
  if (updates.bot_token !== undefined) {
    fields.push(`bot_token = $${paramIdx++}`);
    values.push(updates.bot_token);
  }
  if (updates.base_url !== undefined) {
    fields.push(`base_url = $${paramIdx++}`);
    values.push(updates.base_url);
  }
  if (updates.get_updates_buf !== undefined) {
    fields.push(`get_updates_buf = $${paramIdx++}`);
    values.push(updates.get_updates_buf);
  }
  if (updates.enabled !== undefined) {
    fields.push(`enabled = $${paramIdx++}`);
    values.push(updates.enabled);
  }

  if (fields.length === 0) return;
  values.push(id);
  await pool.query(
    `UPDATE accounts SET ${fields.join(', ')} WHERE id = $${paramIdx}`,
    values,
  );
}

export async function deleteAccount(id: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM task_run_logs WHERE task_id IN
       (SELECT id FROM scheduled_tasks WHERE account_id = $1)`,
      [id],
    );
    await client.query('DELETE FROM conversation_logs WHERE account_id = $1', [
      id,
    ]);
    await client.query('DELETE FROM messages WHERE account_id = $1', [id]);
    await client.query('DELETE FROM scheduled_tasks WHERE account_id = $1', [
      id,
    ]);
    // chat_sessions.account_id 是 NOT NULL FK，必须删除
    await client.query('DELETE FROM chat_sessions WHERE account_id = $1', [id]);
    await client.query('DELETE FROM accounts WHERE id = $1', [id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// =====================
// --- Message accessors ---
// =====================

export async function storeMessage(msg: NewMessage): Promise<void> {
  await pool.query(
    `INSERT INTO messages (id, account_id, user_id, sender, sender_name, content, timestamp, is_from_me, is_bot_message, tool_context, session_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (id, account_id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       sender = EXCLUDED.sender,
       sender_name = EXCLUDED.sender_name,
       content = EXCLUDED.content,
       timestamp = EXCLUDED.timestamp,
       is_from_me = EXCLUDED.is_from_me,
       is_bot_message = EXCLUDED.is_bot_message,
       tool_context = EXCLUDED.tool_context,
       session_id = EXCLUDED.session_id,
       metadata = EXCLUDED.metadata`,
    [
      msg.id,
      msg.account_id,
      msg.user_id ?? null,
      msg.sender,
      msg.sender_name,
      msg.content,
      msg.timestamp,
      msg.is_from_me ?? false,
      msg.is_bot_message ?? false,
      msg.tool_context ?? null,
      msg.session_id ?? null,
      msg.metadata ? JSON.stringify(msg.metadata) : null,
    ],
  );

  // AI 对话消息不同步到 Redis（Redis 仅用于微信 recall_history 工具）
  if (msg.session_id) return;

  // 同步到 Redis，供容器侧 recall_history 工具按需检索
  try {
    const redis = getRedis();
    const key = `history:${msg.account_id}`;
    const entry = JSON.stringify({
      sender: msg.sender,
      sender_name: msg.sender_name,
      content: msg.content,
      timestamp: msg.timestamp,
      is_from_me: msg.is_from_me ?? false,
    });
    await redis.lpush(key, entry);
    await redis.ltrim(key, 0, HISTORY_REDIS_MAX - 1);
  } catch (err) {
    // Redis 写入失败不影响核心消息流程
    logger.warn({ err, accountId: msg.account_id }, '消息同步到 Redis 失败');
  }
}

export async function getRecentMessages(
  accountId: string,
  limit: number = 50,
  before?: string,
  after?: string,
  sessionId?: string,
): Promise<NewMessage[]> {
  const conditions = ['account_id = $1', 'deleted_at IS NULL'];
  const params: unknown[] = [accountId, limit];

  if (sessionId) {
    params.push(sessionId);
    conditions.push(`session_id = $${params.length}`);
  } else {
    conditions.push('session_id IS NULL');
  }

  if (before) {
    params.push(before);
    conditions.push(`timestamp < $${params.length}`);
  }
  if (after) {
    params.push(after);
    conditions.push(`timestamp > $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT * FROM messages
     WHERE ${conditions.join(' AND ')}
     ORDER BY timestamp DESC LIMIT $2`,
    params,
  );
  return rows as NewMessage[];
}

export async function getSessionMessageById(
  accountId: string,
  sessionId: string,
  messageId: string,
): Promise<NewMessage | undefined> {
  const { rows } = await pool.query(
    `SELECT * FROM messages
     WHERE account_id = $1
       AND session_id = $2
       AND id = $3
       AND deleted_at IS NULL
     LIMIT 1`,
    [accountId, sessionId, messageId],
  );
  return rows[0] as NewMessage | undefined;
}

export async function getMessagesSince(
  accountId: string,
  sinceTimestamp: string,
  limit: number = 200,
): Promise<NewMessage[]> {
  const { rows } = await pool.query(
    `SELECT * FROM messages
     WHERE account_id = $1 AND timestamp > $2 AND is_bot_message = false AND deleted_at IS NULL
     ORDER BY timestamp DESC LIMIT $3`,
    [accountId, sinceTimestamp, limit],
  );
  return rows as NewMessage[];
}

// =====================
// --- Conversation log accessors ---
// =====================

export interface ConversationLogRow {
  id: string;
  account_id: string;
  request_id: string;
  transcript: unknown[];
  usage: unknown;
  model: string | null;
  provider: string | null;
  trace_events: unknown[] | null;
  agent_graph: unknown | null;
  agent_graph_summary: unknown | null;
  capability_ledger: unknown | null;
  created_at: string;
}

/**
 * 列表场景下的轻量行，不含 transcript / trace_events 正文，
 * 只保留元数据 + 计数字段。
 *
 * 动机：单行完整 JSONB 可能 20-200KB，20 行列表响应会达到 MB 级别，
 * 拖慢首屏和分页。列表只需要扫读信息，详情用 getConversationLogById /
 * getConversationLogByRequestId 按需拉完整数据。
 */
export interface ConversationLogSummaryRow {
  id: string;
  account_id: string;
  request_id: string;
  usage: unknown;
  model: string | null;
  provider: string | null;
  agent_graph_summary: unknown | null;
  created_at: string;
  tool_call_count: number;
  transcript_event_count: number;
  trace_event_count: number;
}

function countToolUseEvents(transcript: unknown[]): number {
  return transcript.reduce<number>((count, event) => {
    if (
      event &&
      typeof event === 'object' &&
      'type' in event &&
      (event as { type?: unknown }).type === 'tool_use'
    ) {
      return count + 1;
    }
    return count;
  }, 0);
}

export async function storeConversationLog(log: {
  id: string;
  accountId: string;
  requestId: string;
  transcript: unknown[];
  usage?: unknown;
  model?: string | null;
  provider?: string | null;
  traceEvents?: unknown[];
  agentGraph?: unknown;
}): Promise<void> {
  const graphSummary =
    log.agentGraph &&
    typeof log.agentGraph === 'object' &&
    'summary' in (log.agentGraph as Record<string, unknown>)
      ? (log.agentGraph as Record<string, unknown>).summary
      : null;
  const transcript = log.transcript ?? [];
  const traceEvents = log.traceEvents ?? [];
  const capabilityLedger = buildConversationCapabilityLedger(traceEvents);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO conversation_logs (
         id, account_id, request_id, usage, model, provider,
         transcript_event_count, tool_call_count, trace_event_count,
         agent_graph_summary, capability_ledger, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        log.id,
        log.accountId,
        log.requestId,
        log.usage ? JSON.stringify(log.usage) : null,
        log.model ?? null,
        log.provider ?? null,
        transcript.length,
        countToolUseEvents(transcript),
        traceEvents.length,
        graphSummary ? JSON.stringify(graphSummary) : null,
        capabilityLedger ? JSON.stringify(capabilityLedger) : null,
      ],
    );
    await client.query(
      `INSERT INTO conversation_log_payloads (log_id, transcript, trace_events, agent_graph)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (log_id) DO NOTHING`,
      [
        log.id,
        JSON.stringify(transcript),
        traceEvents.length > 0 ? JSON.stringify(traceEvents) : null,
        log.agentGraph ? JSON.stringify(log.agentGraph) : null,
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getConversationLogs(
  accountId: string,
  limit: number = 20,
  before?: string,
): Promise<ConversationLogRow[]> {
  const conditions = ['l.account_id = $1'];
  const params: unknown[] = [accountId, limit];

  if (before) {
    params.push(before);
    conditions.push(`l.created_at < $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT
       l.id,
       l.account_id,
       l.request_id,
       COALESCE(p.transcript, '[]'::jsonb) AS transcript,
       l.usage,
       l.model,
       l.provider,
       p.trace_events,
       p.agent_graph,
       l.agent_graph_summary,
       l.capability_ledger,
       l.created_at
     FROM conversation_logs l
     LEFT JOIN conversation_log_payloads p ON p.log_id = l.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY l.created_at DESC LIMIT $2`,
    params,
  );
  return rows as ConversationLogRow[];
}

/**
 * 列表场景下的轻量查询。仅用于 admin 面板 /api/admin/logs——
 * 不 SELECT transcript / trace_events 正文列，只返回元数据和计数字段，
 * 响应体积从几 MB 降到几十 KB。前端展开 LogCard 时用
 * getConversationLogById 按需拉取完整数据。
 */
export async function getConversationLogSummaries(
  accountId: string,
  limit: number = 20,
  before?: string,
): Promise<ConversationLogSummaryRow[]> {
  const conditions = ['account_id = $1'];
  const params: unknown[] = [accountId, limit];

  if (before) {
    params.push(before);
    conditions.push(`created_at < $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT
       id, account_id, request_id, usage, model, provider, agent_graph_summary, created_at,
       tool_call_count, transcript_event_count, trace_event_count
     FROM conversation_logs
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC LIMIT $2`,
    params,
  );
  return rows as ConversationLogSummaryRow[];
}

export async function getConversationLogById(
  id: string,
): Promise<ConversationLogRow | undefined> {
  const { rows } = await pool.query(
    `SELECT
       l.id,
       l.account_id,
       l.request_id,
       COALESCE(p.transcript, '[]'::jsonb) AS transcript,
       l.usage,
       l.model,
       l.provider,
       p.trace_events,
       p.agent_graph,
       l.agent_graph_summary,
       l.capability_ledger,
       l.created_at
     FROM conversation_logs l
     LEFT JOIN conversation_log_payloads p ON p.log_id = l.id
     WHERE l.id = $1`,
    [id],
  );
  return rows[0] as ConversationLogRow | undefined;
}

/**
 * 按 request_id 查单条 log，admin 排障场景使用。
 * 依赖 idx_conversation_logs_request_id B-tree 索引。
 */
export async function getConversationLogByRequestId(
  requestId: string,
): Promise<ConversationLogRow | undefined> {
  const { rows } = await pool.query(
    `SELECT
       l.id,
       l.account_id,
       l.request_id,
       COALESCE(p.transcript, '[]'::jsonb) AS transcript,
       l.usage,
       l.model,
       l.provider,
       p.trace_events,
       p.agent_graph,
       l.agent_graph_summary,
       l.capability_ledger,
       l.created_at
     FROM conversation_logs l
     LEFT JOIN conversation_log_payloads p ON p.log_id = l.id
     WHERE l.request_id = $1
     ORDER BY l.created_at DESC
     LIMIT 1`,
    [requestId],
  );
  return rows[0] as ConversationLogRow | undefined;
}

export async function getConversationLogsByTimeWindow(
  accountId: string,
  around: string,
  windowSeconds: number = 60,
): Promise<ConversationLogRow[]> {
  const { rows } = await pool.query(
    `SELECT
       l.id,
       l.account_id,
       l.request_id,
       COALESCE(p.transcript, '[]'::jsonb) AS transcript,
       l.usage,
       l.model,
       l.provider,
       p.trace_events,
       p.agent_graph,
       l.agent_graph_summary,
       l.capability_ledger,
       l.created_at
     FROM conversation_logs l
     LEFT JOIN conversation_log_payloads p ON p.log_id = l.id
     WHERE l.account_id = $1
       AND l.created_at BETWEEN ($2::timestamptz - interval '1 second' * $3)
                         AND ($2::timestamptz + interval '10 seconds')
     ORDER BY l.created_at DESC
     LIMIT 5`,
    [accountId, around, windowSeconds],
  );
  return rows as ConversationLogRow[];
}

/**
 * 清理过期 trace_events：把 N 天前的 trace_events 列置 NULL。
 * transcript / usage / agent_graph_summary 等业务数据保留不变。
 *
 * trace 是纯调试数据，保留短期用于排障，过期后释放存储空间。
 * 返回被清理的行数。
 */
export async function purgeExpiredTraceEvents(
  retentionDays: number,
): Promise<number> {
  // 分批 UPDATE 防止生产大数据量时长事务锁表 + WAL 膨胀
  const BATCH_SIZE = 1000;
  let totalCleared = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await pool.query(
      `WITH target AS (
         SELECT p.log_id
         FROM conversation_log_payloads p
         JOIN conversation_logs l ON l.id = p.log_id
         WHERE p.trace_events IS NOT NULL
           AND l.created_at < NOW() - (INTERVAL '1 day' * $1)
         LIMIT $2
       ),
       cleared AS (
         UPDATE conversation_log_payloads p
         SET trace_events = NULL
         FROM target t
         WHERE p.log_id = t.log_id
         RETURNING p.log_id
       )
       UPDATE conversation_logs l
       SET trace_event_count = 0
       WHERE l.id IN (SELECT log_id FROM cleared)`,
      [retentionDays, BATCH_SIZE],
    );
    const batch = result.rowCount ?? 0;
    totalCleared += batch;
    if (batch < BATCH_SIZE) break;
  }
  return totalCleared;
}

// =====================
// --- Chat session accessors ---
// =====================

export async function createChatSession(session: {
  id: string;
  accountId: string;
  userId: string;
  title: string;
}): Promise<ChatSession> {
  const { rows } = await pool.query(
    `INSERT INTO chat_sessions (id, account_id, user_id, title)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [session.id, session.accountId, session.userId, session.title],
  );
  return rows[0] as ChatSession;
}

export async function getChatSessions(
  accountId: string,
  limit = 100,
): Promise<ChatSession[]> {
  // 单账号会话上限默认 100；用户积累大量历史会话时由调用方分页或翻页加载
  const { rows } = await pool.query(
    `SELECT * FROM chat_sessions
     WHERE account_id = $1 AND deleted_at IS NULL
     ORDER BY updated_at DESC
     LIMIT $2`,
    [accountId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows as ChatSession[];
}

export async function getChatSessionsByUserId(
  userId: string,
  limit = 100,
): Promise<ChatSession[]> {
  const { rows } = await pool.query(
    `SELECT * FROM chat_sessions
     WHERE user_id = $1 AND deleted_at IS NULL
     ORDER BY updated_at DESC
     LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows as ChatSession[];
}

export async function getChatSession(
  id: string,
): Promise<ChatSession | undefined> {
  const { rows } = await pool.query(
    'SELECT * FROM chat_sessions WHERE id = $1 AND deleted_at IS NULL',
    [id],
  );
  return rows[0] as ChatSession | undefined;
}

export async function updateChatSessionTitle(
  id: string,
  title: string,
): Promise<void> {
  await pool.query(
    `UPDATE chat_sessions SET title = $2, updated_at = NOW() WHERE id = $1`,
    [id, title],
  );
}

export async function touchChatSession(id: string): Promise<void> {
  await pool.query(
    `UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1`,
    [id],
  );
}

export async function deleteChatSession(id: string): Promise<void> {
  await pool.query(
    `UPDATE chat_sessions SET deleted_at = NOW() WHERE id = $1`,
    [id],
  );
  await pool.query(
    `UPDATE messages SET deleted_at = NOW() WHERE session_id = $1 AND deleted_at IS NULL`,
    [id],
  );
}

// =====================
// --- Task accessors ---
// =====================

export async function createTask(
  task: Omit<
    ScheduledTask,
    'last_run' | 'last_result' | 'scheduler_locked_until'
  >,
): Promise<void> {
  await pool.query(
    `INSERT INTO scheduled_tasks (id, account_id, prompt, schedule_type, schedule_value, reminder_type, voice_text, next_run, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      task.id,
      task.account_id,
      task.prompt,
      task.schedule_type,
      task.schedule_value,
      task.reminder_type ?? null,
      task.voice_text ?? null,
      task.next_run,
      task.status,
      task.created_at,
    ],
  );
}

export async function getTaskById(
  id: string,
): Promise<ScheduledTask | undefined> {
  const { rows } = await pool.query(
    'SELECT * FROM scheduled_tasks WHERE id = $1 AND deleted_at IS NULL',
    [id],
  );
  return rows[0] as ScheduledTask | undefined;
}

export async function getTasksForAccount(
  accountId: string,
): Promise<ScheduledTask[]> {
  const { rows } = await pool.query(
    'SELECT * FROM scheduled_tasks WHERE account_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC',
    [accountId],
  );
  return rows as ScheduledTask[];
}

export async function getAllTasks(): Promise<ScheduledTask[]> {
  const { rows } = await pool.query(
    'SELECT * FROM scheduled_tasks WHERE deleted_at IS NULL ORDER BY created_at DESC',
  );
  return rows as ScheduledTask[];
}

export async function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'reminder_type'
      | 'voice_text'
      | 'next_run'
      | 'status'
    >
  >,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (updates.prompt !== undefined) {
    fields.push(`prompt = $${paramIdx++}`);
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push(`schedule_type = $${paramIdx++}`);
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push(`schedule_value = $${paramIdx++}`);
    values.push(updates.schedule_value);
  }
  if (updates.reminder_type !== undefined) {
    fields.push(`reminder_type = $${paramIdx++}`);
    values.push(updates.reminder_type);
  }
  if (updates.voice_text !== undefined) {
    fields.push(`voice_text = $${paramIdx++}`);
    values.push(updates.voice_text);
  }
  if (updates.next_run !== undefined) {
    fields.push(`next_run = $${paramIdx++}`);
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push(`status = $${paramIdx++}`);
    values.push(updates.status);
    fields.push('scheduler_locked_until = NULL');
  }

  if (fields.length === 0) return;
  values.push(id);
  await pool.query(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = $${paramIdx}`,
    values,
  );
}

export async function deleteTask(id: string): Promise<void> {
  await pool.query('DELETE FROM task_run_logs WHERE task_id = $1', [id]);
  await pool.query('DELETE FROM scheduled_tasks WHERE id = $1', [id]);
}

export async function claimDueTasks(
  lockUntil: string,
  limit = 50,
): Promise<ScheduledTask[]> {
  const now = new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `WITH due AS (
         SELECT id
         FROM scheduled_tasks
         WHERE status = 'active'
           AND next_run IS NOT NULL
           AND next_run <= $1::timestamptz
           AND deleted_at IS NULL
           AND (
             scheduler_locked_until IS NULL
             OR scheduler_locked_until <= $1::timestamptz
           )
         ORDER BY next_run
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       UPDATE scheduled_tasks AS t
       SET scheduler_locked_until = $2::timestamptz
       FROM due
       WHERE t.id = due.id
       RETURNING t.*`,
      [now, lockUntil, limit],
    );
    await client.query('COMMIT');
    return rows as ScheduledTask[];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function extendTaskRunLock(
  id: string,
  lockUntil: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE scheduled_tasks
     SET scheduler_locked_until = $2::timestamptz
     WHERE id = $1
       AND deleted_at IS NULL
       AND status = 'active'
       AND scheduler_locked_until IS NOT NULL`,
    [id, lockUntil],
  );
  return (rowCount ?? 0) > 0;
}

export async function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): Promise<void> {
  const now = new Date().toISOString();
  await pool.query(
    `UPDATE scheduled_tasks
     SET next_run = $1::timestamptz, last_run = $2, last_result = $3,
         scheduler_locked_until = NULL,
         status = CASE WHEN $1::timestamptz IS NULL THEN 'completed' ELSE status END
     WHERE id = $4`,
    [nextRun, now, lastResult, id],
  );
}

export async function logTaskRun(log: TaskRunLog): Promise<void> {
  await pool.query(
    `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      log.task_id,
      log.run_at,
      log.duration_ms,
      log.status,
      log.result,
      log.error,
    ],
  );
}

// =====================
// --- User accessors ---
// =====================

export async function createUser(user: User): Promise<void> {
  await pool.query(
    `INSERT INTO users
       (id, phone, phone_verified, password_hash, role,
        purchased_points, bonus_points, earned_points, reserved_points, pending_withdrawal_points,
        created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      user.id,
      user.phone,
      user.phone_verified,
      user.password_hash,
      user.role,
      user.purchased_points,
      user.bonus_points,
      user.earned_points,
      user.reserved_points,
      user.pending_withdrawal_points,
      user.created_at,
    ],
  );
}

export async function getAllUsers(): Promise<User[]> {
  const { rows } = await pool.query(
    `SELECT ${USER_SELECT_COLUMNS}
     FROM users u
     ORDER BY u.created_at DESC`,
  );
  return rows as User[];
}

export async function deleteUser(userId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 删除用户作为订阅者 / 创作者 / 拥有者的全部关系数据
    await client.query(
      `DELETE FROM creator_bundle_subscriptions
       WHERE subscriber_id = $1 OR creator_id = $1`,
      [userId],
    );
    await client.query(
      `DELETE FROM user_skill_subscriptions
       WHERE subscriber_id = $1
          OR skill_id IN (SELECT id FROM user_custom_skills WHERE user_id = $1)`,
      [userId],
    );
    await client.query('DELETE FROM skill_bundles WHERE user_id = $1', [
      userId,
    ]);
    await client.query(
      'DELETE FROM creator_bundle_config WHERE creator_id = $1',
      [userId],
    );
    await client.query(
      'DELETE FROM creator_withdrawals WHERE creator_id = $1',
      [userId],
    );
    await client.query(
      'DELETE FROM creator_earnings_monthly WHERE creator_id = $1',
      [userId],
    );
    await client.query(
      'DELETE FROM billing_request_reservations WHERE user_id = $1',
      [userId],
    );
    await client.query('DELETE FROM monthly_billing_state WHERE user_id = $1', [
      userId,
    ]);
    await client.query('DELETE FROM wallet_transactions WHERE user_id = $1', [
      userId,
    ]);
    await client.query('DELETE FROM point_batches WHERE user_id = $1', [
      userId,
    ]);
    await client.query('DELETE FROM user_custom_skills WHERE user_id = $1', [
      userId,
    ]);

    // 删除用户拥有的账号链路
    await client.query(
      `DELETE FROM task_run_logs WHERE task_id IN
       (SELECT t.id FROM scheduled_tasks t JOIN accounts a ON a.id = t.account_id WHERE a.owner_id = $1)`,
      [userId],
    );
    await client.query(
      `DELETE FROM scheduled_tasks WHERE account_id IN
       (SELECT id FROM accounts WHERE owner_id = $1)`,
      [userId],
    );
    await client.query(
      `DELETE FROM conversation_logs WHERE account_id IN
       (SELECT id FROM accounts WHERE owner_id = $1)`,
      [userId],
    );
    await client.query(
      `DELETE FROM messages WHERE account_id IN
       (SELECT id FROM accounts WHERE owner_id = $1)`,
      [userId],
    );
    await client.query(
      `DELETE FROM chat_sessions WHERE account_id IN
       (SELECT id FROM accounts WHERE owner_id = $1)`,
      [userId],
    );
    await client.query('DELETE FROM daily_usage WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM user_skills WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM accounts WHERE owner_id = $1', [userId]);
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getUserById(id: string): Promise<User | undefined> {
  return getUserByIdUsing(pool, id);
}

export async function getUserByPhone(phone: string): Promise<User | undefined> {
  return getUserByPhoneUsing(pool, phone);
}

export async function updateUserPasswordHash(
  userId: string,
  passwordHash: string,
): Promise<User> {
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
    passwordHash,
    userId,
  ]);
  const user = await getUserById(userId);
  if (!user) {
    throw new Error('用户不存在');
  }
  return user;
}

export async function getUserByAccountId(
  accountId: string,
): Promise<User | undefined> {
  const { rows } = await pool.query(
    `SELECT ${USER_SELECT_COLUMNS}
     FROM users u
     JOIN accounts a ON a.owner_id = u.id
     WHERE a.id = $1`,
    [accountId],
  );
  return rows[0] as User | undefined;
}

export interface WalletTransactionRow {
  id: string;
  user_id: string;
  kind: string;
  amount_points: number;
  reserved_delta_points: number;
  point_source: 'purchased' | 'bonus' | 'earned' | 'mixed' | null;
  point_batch_id: string | null;
  request_id: string | null;
  note: string | null;
  metadata: unknown;
  created_at: string;
}

/**
 * 根据 wallet_transactions.kind 推断 point_source。
 * 调用方可覆写（如 overage_charge 的细化为 'bonus'/'purchased'/'mixed'）。
 */
function inferPointSourceFromKind(
  kind: string,
): 'purchased' | 'bonus' | 'earned' | 'mixed' | null {
  switch (kind) {
    case 'recharge_topup':
    case 'manual_topup':
    case 'manual_adjustment':
      return 'purchased';
    case 'creator_revenue':
      return 'earned';
    case 'overage_charge':
    case 'skill_subscription':
    case 'bundle_subscription':
      return 'mixed';
    case 'reservation_release':
    default:
      return null;
  }
}

export interface MonthlyBillingStateRow {
  user_id: string;
  year_month: string;
  billed_overage_tokens: number;
  billed_overage_cost_points: number;
  updated_at: string;
}

export interface BillingRequestReservationRow {
  request_id: string;
  user_id: string;
  model_config_id: string | null;
  year_month: string;
  reserved_points: number;
  hold_state: 'none' | 'held' | 'released';
  charge_state: 'pending' | 'charged';
  actual_charge_points: number;
  total_overage_tokens: number;
  total_overage_cost_points: number;
  note: string | null;
  metadata: unknown;
  released_at: string | null;
  charged_at: string | null;
  created_at: string;
  updated_at: string;
}

export type RechargePayType = 'alipay' | 'wechat';
export type RechargeOrderStatus = 'pending' | 'paid' | 'failed';

export interface RechargeOrderRow {
  id: string;
  user_id: string;
  trade_id: string;
  provider: 'epay' | string;
  provider_trade_id: string | null;
  pay_type: RechargePayType;
  amount_yuan: string;
  amount_points: number;
  pay_url: string | null;
  status: RechargeOrderStatus;
  paid_at: string | null;
  notified_at: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

export interface RechargeStatsRow {
  total_paid_orders: number;
  total_recharge_points: number;
  total_recharge_yuan: string;
  last_paid_at: string | null;
}

export interface RechargePaymentConfigRow {
  id: 'default' | string;
  enabled: boolean;
  min_yuan: string;
  max_yuan: string;
  epay_url_prefix: string;
  epay_platform_id: number | null;
  epay_merchant_private_key: string;
  epay_platform_public_key: string;
  epay_merchant_key: string;
  notify_url: string;
  return_url: string;
  updated_at: string;
}

async function insertWalletTransaction(
  client: pg.PoolClient,
  input: {
    userId: string;
    kind: string;
    amountPoints?: number;
    reservedDeltaPoints?: number;
    pointSource?: 'purchased' | 'bonus' | 'earned' | 'mixed' | null;
    pointBatchId?: string | null;
    requestId?: string | null;
    note?: string | null;
    metadata?: unknown;
  },
): Promise<void> {
  const amountPoints = input.amountPoints ?? 0;
  const reservedDeltaPoints = input.reservedDeltaPoints ?? 0;
  const pointSource =
    input.pointSource !== undefined
      ? input.pointSource
      : inferPointSourceFromKind(input.kind);

  // amount_cents / reserved_delta_cents 列仍存在（未 DROP），
  // 但不再由业务写入——DB DEFAULT 0 承接，直到 Stage 5 移除该列
  await client.query(
    `INSERT INTO wallet_transactions
      (id, user_id, kind,
       amount_points, reserved_delta_points, point_source, point_batch_id,
       request_id, note, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
    [
      `wtx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      input.userId,
      input.kind,
      amountPoints,
      reservedDeltaPoints,
      pointSource,
      input.pointBatchId ?? null,
      input.requestId ?? null,
      input.note ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
}

export async function getRechargePaymentConfig(): Promise<RechargePaymentConfigRow> {
  const { rows } = await pool.query(
    `INSERT INTO recharge_payment_config (id)
     VALUES ('default')
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING *`,
  );
  return rows[0] as RechargePaymentConfigRow;
}

export async function updateRechargePaymentConfig(input: {
  enabled: boolean;
  minYuan: string;
  maxYuan: string;
  epayUrlPrefix: string;
  epayPlatformId: number | null;
  epayMerchantPrivateKey: string;
  epayPlatformPublicKey: string;
  epayMerchantKey: string;
  notifyUrl: string;
  returnUrl: string;
}): Promise<RechargePaymentConfigRow> {
  const { rows } = await pool.query(
    `INSERT INTO recharge_payment_config (
       id, enabled, min_yuan, max_yuan, epay_url_prefix, epay_platform_id,
       epay_merchant_private_key, epay_platform_public_key, epay_merchant_key,
       notify_url, return_url, updated_at
     )
     VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       min_yuan = EXCLUDED.min_yuan,
       max_yuan = EXCLUDED.max_yuan,
       epay_url_prefix = EXCLUDED.epay_url_prefix,
       epay_platform_id = EXCLUDED.epay_platform_id,
       epay_merchant_private_key = EXCLUDED.epay_merchant_private_key,
       epay_platform_public_key = EXCLUDED.epay_platform_public_key,
       epay_merchant_key = EXCLUDED.epay_merchant_key,
       notify_url = EXCLUDED.notify_url,
       return_url = EXCLUDED.return_url,
       updated_at = NOW()
     RETURNING *`,
    [
      input.enabled,
      input.minYuan,
      input.maxYuan,
      input.epayUrlPrefix,
      input.epayPlatformId,
      input.epayMerchantPrivateKey,
      input.epayPlatformPublicKey,
      input.epayMerchantKey,
      input.notifyUrl,
      input.returnUrl,
    ],
  );
  return rows[0] as RechargePaymentConfigRow;
}

export async function insertRechargeOrder(input: {
  id: string;
  userId: string;
  tradeId: string;
  payType: RechargePayType;
  amountYuan: string;
  amountPoints: number;
  metadata?: unknown;
}): Promise<RechargeOrderRow> {
  const { rows } = await pool.query(
    `INSERT INTO recharge_orders
       (id, user_id, trade_id, provider, pay_type, amount_yuan,
        amount_points, status, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, 'epay', $4, $5, $6, 'pending', $7, NOW(), NOW())
     RETURNING *`,
    [
      input.id,
      input.userId,
      input.tradeId,
      input.payType,
      input.amountYuan,
      input.amountPoints,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  return rows[0] as RechargeOrderRow;
}

export async function markRechargeOrderPaymentCreated(input: {
  tradeId: string;
  providerTradeId?: string | null;
  payUrl: string;
  metadata?: unknown;
}): Promise<RechargeOrderRow> {
  const { rows } = await pool.query(
    `UPDATE recharge_orders
     SET provider_trade_id = COALESCE($2, provider_trade_id),
         pay_url = $3,
         metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
         updated_at = NOW()
     WHERE trade_id = $1
     RETURNING *`,
    [
      input.tradeId,
      input.providerTradeId ?? null,
      input.payUrl,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  if (rows.length === 0) {
    throw new Error('充值单不存在');
  }
  return rows[0] as RechargeOrderRow;
}

export async function markRechargeOrderFailed(
  tradeId: string,
  reason: string,
): Promise<void> {
  await pool.query(
    `UPDATE recharge_orders
     SET status = 'failed',
         metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE trade_id = $1 AND status = 'pending'`,
    [tradeId, JSON.stringify({ failure_reason: reason })],
  );
}

export async function getRechargeOrderByTradeId(
  tradeId: string,
): Promise<RechargeOrderRow | undefined> {
  const { rows } = await pool.query(
    `SELECT * FROM recharge_orders WHERE trade_id = $1`,
    [tradeId],
  );
  return rows[0] as RechargeOrderRow | undefined;
}

export async function getRechargeOrderByTradeIdForUser(
  userId: string,
  tradeId: string,
): Promise<RechargeOrderRow | undefined> {
  const { rows } = await pool.query(
    `SELECT * FROM recharge_orders
     WHERE user_id = $1 AND trade_id = $2`,
    [userId, tradeId],
  );
  return rows[0] as RechargeOrderRow | undefined;
}

export async function listRechargeOrdersByUserId(
  userId: string,
  limit = 20,
): Promise<RechargeOrderRow[]> {
  const { rows } = await pool.query(
    `SELECT * FROM recharge_orders
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 100)],
  );
  return rows as RechargeOrderRow[];
}

export async function getRechargeStatsByUserId(
  userId: string,
): Promise<RechargeStatsRow> {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'paid')::int AS total_paid_orders,
       COALESCE(SUM(amount_points) FILTER (WHERE status = 'paid'), 0)::int
         AS total_recharge_points,
       COALESCE(SUM(amount_yuan) FILTER (WHERE status = 'paid'), 0)::text
         AS total_recharge_yuan,
       MAX(paid_at) FILTER (WHERE status = 'paid') AS last_paid_at
     FROM recharge_orders
     WHERE user_id = $1`,
    [userId],
  );
  return rows[0] as RechargeStatsRow;
}

export async function settleRechargeOrderPaid(input: {
  tradeId: string;
  providerTradeId?: string | null;
  payType?: RechargePayType | null;
  paidAt?: string | Date | null;
  notifyPayload?: unknown;
}): Promise<RechargeOrderRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: orderRows } = await client.query(
      `SELECT * FROM recharge_orders
       WHERE trade_id = $1
       FOR UPDATE`,
      [input.tradeId],
    );
    const order = orderRows[0] as RechargeOrderRow | undefined;
    if (!order) {
      throw new Error('充值单不存在');
    }

    // 支付平台通知可能重复到达，已入账订单直接返回，保证幂等。
    if (order.status === 'paid') {
      await client.query('COMMIT');
      return order;
    }
    if (order.status !== 'pending') {
      throw new Error('充值单状态不可入账');
    }

    await client.query(
      `UPDATE users
       SET purchased_points = purchased_points + $1
       WHERE id = $2`,
      [order.amount_points, order.user_id],
    );

    await insertWalletTransaction(client, {
      userId: order.user_id,
      kind: 'recharge_topup',
      amountPoints: order.amount_points,
      pointSource: 'purchased',
      requestId: order.trade_id,
      note: `充值到账 ¥${order.amount_yuan}`,
      metadata: {
        trade_id: order.trade_id,
        provider: order.provider,
        provider_trade_id: input.providerTradeId ?? order.provider_trade_id,
        pay_type: input.payType ?? order.pay_type,
      },
    });

    const { rows: updatedRows } = await client.query(
      `UPDATE recharge_orders
       SET status = 'paid',
           provider_trade_id = COALESCE($2, provider_trade_id),
           pay_type = COALESCE($3::text, pay_type),
           paid_at = COALESCE($4::timestamptz, NOW()),
           notified_at = NOW(),
           metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
           updated_at = NOW()
       WHERE trade_id = $1
       RETURNING *`,
      [
        order.trade_id,
        input.providerTradeId ?? null,
        input.payType ?? null,
        input.paidAt ?? null,
        JSON.stringify({ notify_payload: input.notifyPayload ?? null }),
      ],
    );

    await client.query('COMMIT');
    return updatedRows[0] as RechargeOrderRow;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function insertBillingRequestReservation(
  client: pg.PoolClient,
  input: {
    requestId: string;
    userId: string;
    modelConfigId?: string | null;
    yearMonth: string;
    reservedPoints: number;
    holdState: BillingRequestReservationRow['hold_state'];
    note?: string | null;
    metadata?: unknown;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO billing_request_reservations
      (request_id, user_id, model_config_id, year_month, reserved_points,
       hold_state, charge_state, note, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, NOW(), NOW())
     ON CONFLICT (request_id) DO NOTHING`,
    [
      input.requestId,
      input.userId,
      input.modelConfigId ?? null,
      input.yearMonth,
      input.reservedPoints,
      input.holdState,
      input.note ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
}

export async function getBillingRequestReservationByRequestId(
  requestId: string,
): Promise<BillingRequestReservationRow | undefined> {
  const { rows } = await pool.query(
    'SELECT * FROM billing_request_reservations WHERE request_id = $1',
    [requestId],
  );
  return rows[0] as BillingRequestReservationRow | undefined;
}

export async function listBillingRequestReservations(opts?: {
  userId?: string;
  holdState?: BillingRequestReservationRow['hold_state'];
  chargeState?: BillingRequestReservationRow['charge_state'];
  limit?: number;
}): Promise<BillingRequestReservationRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (opts?.userId) {
    where.push(`user_id = $${idx++}`);
    values.push(opts.userId);
  }
  if (opts?.holdState) {
    where.push(`hold_state = $${idx++}`);
    values.push(opts.holdState);
  }
  if (opts?.chargeState) {
    where.push(`charge_state = $${idx++}`);
    values.push(opts.chargeState);
  }
  values.push(Math.min(opts?.limit ?? 50, 200));
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM billing_request_reservations
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${idx}`,
    values,
  );
  return rows as BillingRequestReservationRow[];
}

export async function reconcileStaleBillingReservations(
  staleBeforeIso: string,
  limit = 100,
): Promise<{ released: number; requestIds: string[] }> {
  const rows = await listBillingRequestReservations({
    holdState: 'held',
    chargeState: 'pending',
    limit,
  });
  let released = 0;
  const requestIds: string[] = [];

  for (const row of rows) {
    if (new Date(row.updated_at).toISOString() > staleBeforeIso) continue;
    try {
      await releaseUserReservation(row.request_id, '陈旧预留自动释放', {
        source: 'reconcile',
      });
      released++;
      requestIds.push(row.request_id);
    } catch (err) {
      logger.warn({ requestId: row.request_id, err }, '自动释放陈旧预留失败');
    }
  }

  return { released, requestIds };
}

export async function getWalletTransactionsByUserId(
  userId: string,
  limit = 20,
): Promise<WalletTransactionRow[]> {
  const { rows } = await pool.query(
    `SELECT * FROM wallet_transactions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows as WalletTransactionRow[];
}

export async function getVisibleWalletTransactionsByUserId(
  userId: string,
  limit = 20,
): Promise<WalletTransactionRow[]> {
  const { rows } = await pool.query(
    `SELECT * FROM wallet_transactions
     WHERE user_id = $1
       AND amount_points <> 0
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows as WalletTransactionRow[];
}

// =====================
// --- Point batches / 积分扣减算法 ---
// =====================

export interface PointBatchRow {
  id: string;
  user_id: string;
  source: string;
  granted_by: string | null;
  amount_points: number;
  remaining_points: number;
  note: string | null;
  expires_at: string | null;
  status: 'active' | 'exhausted' | 'expired' | 'revoked';
  created_at: string;
  updated_at: string;
}

/**
 * 查询用户当前活跃的赠送积分批次，按"最快过期的在前"排序。
 * 永不过期（expires_at IS NULL）排在最后，保证临期批次优先扣减。
 *
 * 调用方必须已在事务中并持有 users 行的 FOR UPDATE 锁；
 * 本函数内部对批次行 FOR UPDATE 加锁以防并发扣减。
 */
async function getAvailableBonusBatches(
  client: pg.PoolClient,
  userId: string,
): Promise<PointBatchRow[]> {
  const { rows } = await client.query(
    `SELECT * FROM point_batches
     WHERE user_id = $1
       AND status = 'active'
       AND remaining_points > 0
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY expires_at ASC NULLS LAST, created_at ASC
     FOR UPDATE`,
    [userId],
  );
  return rows as PointBatchRow[];
}

export interface DeductPointsResult {
  bonusDeducted: number;
  purchasedDeducted: number;
  batchDeductions: Array<{ batchId: string; points: number }>;
  pointSource: 'purchased' | 'bonus' | 'mixed' | null;
}

/**
 * 内部扣减算法：在一次事务中按 bonus → purchased 顺序扣减积分，
 * 并维护 point_batches.remaining_points / users.{bonus_points,purchased_points}。
 * 返回的 pointSource 会作为 wallet_transactions.point_source 写入流水。
 */
async function deductPoints(
  client: pg.PoolClient,
  user: User,
  chargePoints: number,
  options?: { releasedReservedPoints?: number },
): Promise<DeductPointsResult> {
  if (chargePoints <= 0) {
    return {
      bonusDeducted: 0,
      purchasedDeducted: 0,
      batchDeductions: [],
      pointSource: null,
    };
  }
  assertSufficientSpendablePoints(user, chargePoints, options);

  let bonusLeft = chargePoints;
  const batchDeductions: Array<{ batchId: string; points: number }> = [];

  const batches = await getAvailableBonusBatches(client, user.id);
  for (const batch of batches) {
    if (bonusLeft <= 0) break;
    const toDeduct = Math.min(batch.remaining_points, bonusLeft);
    if (toDeduct <= 0) continue;
    await client.query(
      `UPDATE point_batches
       SET remaining_points = remaining_points - $1,
           status = CASE WHEN remaining_points - $1 <= 0 THEN 'exhausted' ELSE status END,
           updated_at = NOW()
       WHERE id = $2`,
      [toDeduct, batch.id],
    );
    batchDeductions.push({ batchId: batch.id, points: toDeduct });
    bonusLeft -= toDeduct;
  }

  const bonusDeducted = chargePoints - bonusLeft;
  const purchasedDeducted = bonusLeft;
  if (
    user.bonus_points < bonusDeducted ||
    user.purchased_points < purchasedDeducted
  ) {
    throw new Error('余额不足，请充值后继续使用');
  }

  // 更新 users 表的桶字段
  await client.query(
    `UPDATE users
     SET bonus_points = bonus_points - $1,
         purchased_points = purchased_points - $2
     WHERE id = $3`,
    [bonusDeducted, purchasedDeducted, user.id],
  );

  let pointSource: DeductPointsResult['pointSource'];
  if (bonusDeducted > 0 && purchasedDeducted > 0) pointSource = 'mixed';
  else if (bonusDeducted > 0) pointSource = 'bonus';
  else if (purchasedDeducted > 0) pointSource = 'purchased';
  else pointSource = null;

  return {
    bonusDeducted,
    purchasedDeducted,
    batchDeductions,
    pointSource,
  };
}

/**
 * 赠送积分（新用户礼包、签到奖励、活动积分、管理员手动发放）。
 * 原子操作：创建 point_batches 行 → 更新 users.bonus_points → 写流水。
 */
export async function grantBonusPoints(input: {
  userId: string;
  source: PointBatchSource | string;
  amountPoints: number;
  expiresAt?: string | null;
  note?: string | null;
  grantedBy?: string | null;
}): Promise<{ user: User; batchId: string }> {
  if (input.amountPoints <= 0) {
    throw new Error('赠送积分数量必须为正');
  }
  const batchId = `pb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await getUserByIdUsing(client, input.userId, {
      forUpdate: true,
    });
    if (!user) throw new Error('用户不存在');

    await client.query(
      `INSERT INTO point_batches
         (id, user_id, source, granted_by, amount_points, remaining_points,
          note, expires_at, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7, 'active', NOW(), NOW())`,
      [
        batchId,
        input.userId,
        input.source,
        input.grantedBy ?? null,
        input.amountPoints,
        input.note ?? null,
        input.expiresAt ?? null,
      ],
    );

    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET bonus_points = bonus_points + $1
       WHERE id = $2
       RETURNING *`,
      [input.amountPoints, input.userId],
    );

    await insertWalletTransaction(client, {
      userId: input.userId,
      kind: 'bonus_grant',
      amountPoints: input.amountPoints,
      pointSource: 'bonus',
      pointBatchId: batchId,
      note: input.note ?? `赠送积分（${input.source}）`,
      metadata: {
        source: input.source,
        grantedBy: input.grantedBy ?? null,
        expiresAt: input.expiresAt ?? null,
      },
    });

    await client.query('COMMIT');
    return {
      user: updatedRows[0] as User,
      batchId,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 定时任务入口：扫描已过期的活跃批次，批次级过期处理。
 * 每个批次在独立事务内完成：标记 expired → 扣 users.bonus_points → 写流水。
 * FOR UPDATE SKIP LOCKED 保证多实例并发运行时不会重复处理同一批次。
 */
export async function expireBonusPoints(
  beforeIso: string,
  limit = 200,
): Promise<{ expired: number; totalPointsExpired: number }> {
  // 阶段 1：无锁快扫出候选批次（避免长事务）
  const { rows: candidates } = await pool.query(
    `SELECT id FROM point_batches
     WHERE status = 'active'
       AND expires_at IS NOT NULL
       AND expires_at < $1
     ORDER BY expires_at ASC
     LIMIT $2`,
    [beforeIso, limit],
  );

  let expired = 0;
  let totalPointsExpired = 0;

  for (const { id: batchId } of candidates as { id: string }[]) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // SKIP LOCKED：并发实例遇到同一批次会直接跳过
      const { rows } = await client.query(
        `SELECT * FROM point_batches
         WHERE id = $1
           AND status = 'active'
           AND expires_at IS NOT NULL
           AND expires_at < $2
         FOR UPDATE SKIP LOCKED`,
        [batchId, beforeIso],
      );
      const batch = rows[0] as PointBatchRow | undefined;
      if (!batch) {
        await client.query('COMMIT');
        continue;
      }

      const remaining = batch.remaining_points;
      await client.query(
        `UPDATE point_batches
         SET status = 'expired',
             remaining_points = 0,
             updated_at = NOW()
         WHERE id = $1`,
        [batch.id],
      );

      if (remaining > 0) {
        await client.query(
          `UPDATE users
           SET bonus_points = GREATEST(0, bonus_points - $1)
           WHERE id = $2`,
          [remaining, batch.user_id],
        );

        await insertWalletTransaction(client, {
          userId: batch.user_id,
          kind: 'bonus_expire',
          amountPoints: -remaining,
          pointSource: 'bonus',
          pointBatchId: batch.id,
          note: `赠送积分过期（批次 ${batch.id}）`,
          metadata: {
            batch_source: batch.source,
            expires_at: batch.expires_at,
            original_amount: batch.amount_points,
          },
        });
      }

      await client.query('COMMIT');
      expired += 1;
      totalPointsExpired += remaining;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.warn({ batchId, err }, '赠送积分过期处理失败');
    } finally {
      client.release();
    }
  }

  return { expired, totalPointsExpired };
}

export async function getPointBatchesByUserId(
  userId: string,
  opts?: { includeExhausted?: boolean; limit?: number },
): Promise<PointBatchRow[]> {
  const where: string[] = ['user_id = $1'];
  if (!opts?.includeExhausted) {
    where.push(`status = 'active'`);
  }
  const { rows } = await pool.query(
    `SELECT * FROM point_batches
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, Math.min(opts?.limit ?? 50, 200)],
  );
  return rows as PointBatchRow[];
}

// =====================
// --- Creator withdrawals / 创作者提现通道 ---
// =====================

/**
 * 派生 AES-GCM 加密密钥。配置了 WITHDRAWAL_ENCRYPTION_KEY 时使用该值（hex 64 字符），
 * 未配置时用 JWT_SECRET 派生（仅开发环境兜底，生产必须显式配置）。
 */
function getWithdrawalCipherKey(): Buffer {
  if (WITHDRAWAL_ENCRYPTION_KEY && WITHDRAWAL_ENCRYPTION_KEY.length >= 64) {
    return Buffer.from(WITHDRAWAL_ENCRYPTION_KEY.slice(0, 64), 'hex');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '生产环境必须配置 WITHDRAWAL_ENCRYPTION_KEY（64 字符 hex，可用 `openssl rand -hex 32` 生成）',
    );
  }
  // 开发/测试环境：从 JWT_SECRET 派生（SHA-256 取前 32 字节），一次性警告
  if (!derivedKeyWarned) {
    logger.warn(
      '未配置 WITHDRAWAL_ENCRYPTION_KEY，开发环境使用 JWT_SECRET 派生兜底密钥',
    );
    derivedKeyWarned = true;
  }
  return crypto.createHash('sha256').update(JWT_SECRET).digest();
}
let derivedKeyWarned = false;

/** AES-256-GCM 加密。输出格式：base64(iv[12] || ciphertext || authTag[16]) */
export function encryptSensitive(plaintext: string): string {
  if (!plaintext) return '';
  const key = getWithdrawalCipherKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString('base64');
}

export function decryptSensitive(encoded: string | null | undefined): string {
  if (!encoded) return '';
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < 12 + 16) throw new Error('密文格式错误');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(12, buf.length - 16);
  const key = getWithdrawalCipherKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec.toString('utf8');
}

/** 脱敏显示身份证号：只保留前 4 位和后 4 位 */
export function maskIdNumber(id: string): string {
  if (!id) return '';
  if (id.length <= 8) return '*'.repeat(id.length);
  return `${id.slice(0, 4)}${'*'.repeat(id.length - 8)}${id.slice(-4)}`;
}

export interface CreatorWithdrawalRow {
  id: string;
  creator_id: string;
  amount_points: number;
  amount_yuan: string; // NUMERIC as string
  status: 'pending' | 'approved' | 'rejected' | 'paid' | 'cancelled';
  bank_name: string | null;
  bank_account: string | null;
  account_name: string | null;
  id_number: string | null; // AES-GCM 密文 (base64)
  tax_type: 'personal' | 'company' | null;
  company_name: string | null;
  tax_id: string | null;
  platform_fee_points: number;
  tax_amount_yuan: string;
  net_amount_yuan: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  paid_at: string | null;
  payment_proof: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 创作者发起提现申请。冻结 pending_withdrawal_points（不动 earned_points）。
 * 校验：amount_points > 0 且 earned_points - pending_withdrawal_points >= amount_points。
 */
export async function createWithdrawalRequest(input: {
  creatorId: string;
  amountPoints: number;
  bankName?: string | null;
  bankAccount?: string | null;
  accountName?: string | null;
  idNumber?: string | null; // 明文传入，函数内部加密
  taxType?: 'personal' | 'company' | null;
  companyName?: string | null;
  taxId?: string | null;
}): Promise<CreatorWithdrawalRow> {
  if (input.amountPoints <= 0) {
    throw new Error('提现积分必须为正');
  }
  const withdrawalId = `wd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await getUserByIdUsing(client, input.creatorId, {
      forUpdate: true,
    });
    if (!user) throw new Error('用户不存在');

    const withdrawable = user.earned_points - user.pending_withdrawal_points;
    if (withdrawable < input.amountPoints) {
      throw new Error(
        `可提现积分不足：可用 ${withdrawable}，申请 ${input.amountPoints}`,
      );
    }

    // 100 积分 = 1 元
    const amountYuan = (input.amountPoints / 100).toFixed(2);

    await client.query(
      `UPDATE users
       SET pending_withdrawal_points = pending_withdrawal_points + $1
       WHERE id = $2`,
      [input.amountPoints, input.creatorId],
    );

    const idNumberEncrypted = input.idNumber
      ? encryptSensitive(input.idNumber)
      : null;

    const { rows } = await client.query(
      `INSERT INTO creator_withdrawals
        (id, creator_id, amount_points, amount_yuan, status,
         bank_name, bank_account, account_name, id_number,
         tax_type, company_name, tax_id,
         platform_fee_points, tax_amount_yuan, net_amount_yuan,
         created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending',
               $5, $6, $7, $8,
               $9, $10, $11,
               0, 0, $4,
               NOW(), NOW())
       RETURNING *`,
      [
        withdrawalId,
        input.creatorId,
        input.amountPoints,
        amountYuan,
        input.bankName ?? null,
        input.bankAccount ?? null,
        input.accountName ?? null,
        idNumberEncrypted,
        input.taxType ?? null,
        input.companyName ?? null,
        input.taxId ?? null,
      ],
    );

    await client.query('COMMIT');
    return rows[0] as CreatorWithdrawalRow;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getWithdrawalById(
  id: string,
): Promise<CreatorWithdrawalRow | undefined> {
  const { rows } = await pool.query(
    'SELECT * FROM creator_withdrawals WHERE id = $1',
    [id],
  );
  return rows[0] as CreatorWithdrawalRow | undefined;
}

export async function listWithdrawalsForCreator(
  creatorId: string,
  limit = 50,
): Promise<CreatorWithdrawalRow[]> {
  const { rows } = await pool.query(
    `SELECT * FROM creator_withdrawals
     WHERE creator_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [creatorId, Math.min(limit, 200)],
  );
  return rows as CreatorWithdrawalRow[];
}

export async function listAllWithdrawals(opts?: {
  status?: CreatorWithdrawalRow['status'];
  creatorId?: string;
  limit?: number;
}): Promise<CreatorWithdrawalRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (opts?.status) {
    where.push(`status = $${idx++}`);
    values.push(opts.status);
  }
  if (opts?.creatorId) {
    where.push(`creator_id = $${idx++}`);
    values.push(opts.creatorId);
  }
  values.push(Math.min(opts?.limit ?? 50, 200));
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM creator_withdrawals
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${idx}`,
    values,
  );
  return rows as CreatorWithdrawalRow[];
}

/**
 * 审核通过：从 earned_points 正式扣减、释放 pending、写 creator_earnings_monthly.withdrawn_points + 流水。
 * taxAmountYuan / netAmountYuan / platformFeePoints 由管理员审核时决定。
 */
export async function approveWithdrawal(input: {
  withdrawalId: string;
  reviewedBy: string;
  taxAmountYuan?: string;
  netAmountYuan?: string;
  platformFeePoints?: number;
  note?: string | null;
}): Promise<CreatorWithdrawalRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: wdRows } = await client.query(
      'SELECT * FROM creator_withdrawals WHERE id = $1 FOR UPDATE',
      [input.withdrawalId],
    );
    const wd = wdRows[0] as CreatorWithdrawalRow | undefined;
    if (!wd) throw new Error('提现申请不存在');
    if (wd.status !== 'pending') {
      throw new Error(`当前状态 ${wd.status} 无法审核通过`);
    }

    const user = await getUserByIdUsing(client, wd.creator_id, {
      forUpdate: true,
    });
    if (!user) throw new Error('创作者不存在');
    if (user.earned_points < wd.amount_points) {
      throw new Error('创作者可提现积分不足（earned_points 异常）');
    }

    await client.query(
      `UPDATE users
       SET earned_points = earned_points - $1,
           pending_withdrawal_points = GREATEST(0, pending_withdrawal_points - $1)
       WHERE id = $2`,
      [wd.amount_points, wd.creator_id],
    );

    const taxAmountYuan = input.taxAmountYuan ?? '0';
    const netAmountYuan = input.netAmountYuan ?? wd.amount_yuan;
    const platformFeePoints = input.platformFeePoints ?? 0;

    const { rows: updatedRows } = await client.query(
      `UPDATE creator_withdrawals
       SET status = 'approved',
           reviewed_by = $1,
           reviewed_at = NOW(),
           review_note = $2,
           tax_amount_yuan = $3,
           net_amount_yuan = $4,
           platform_fee_points = $5,
           updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [
        input.reviewedBy,
        input.note ?? null,
        taxAmountYuan,
        netAmountYuan,
        platformFeePoints,
        input.withdrawalId,
      ],
    );

    // 更新当月 creator_earnings_monthly.withdrawn_points
    const yearMonth = new Date().toISOString().slice(0, 7);
    await client.query(
      `INSERT INTO creator_earnings_monthly
         (creator_id, year_month,
          gross_points, platform_cut_points, net_points, withdrawn_points,
          updated_at)
       VALUES ($1, $2, 0, 0, 0, $3, NOW())
       ON CONFLICT (creator_id, year_month) DO UPDATE SET
         withdrawn_points = creator_earnings_monthly.withdrawn_points + EXCLUDED.withdrawn_points,
         updated_at = NOW()`,
      [wd.creator_id, yearMonth, wd.amount_points],
    );

    await insertWalletTransaction(client, {
      userId: wd.creator_id,
      kind: 'withdrawal',
      amountPoints: -wd.amount_points,
      pointSource: 'earned',
      note: `提现申请批准：${wd.amount_yuan} 元`,
      metadata: {
        withdrawal_id: wd.id,
        tax_amount_yuan: taxAmountYuan,
        net_amount_yuan: netAmountYuan,
        platform_fee_points: platformFeePoints,
      },
    });

    await client.query('COMMIT');
    return updatedRows[0] as CreatorWithdrawalRow;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function rejectWithdrawal(input: {
  withdrawalId: string;
  reviewedBy: string;
  note: string;
}): Promise<CreatorWithdrawalRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: wdRows } = await client.query(
      'SELECT * FROM creator_withdrawals WHERE id = $1 FOR UPDATE',
      [input.withdrawalId],
    );
    const wd = wdRows[0] as CreatorWithdrawalRow | undefined;
    if (!wd) throw new Error('提现申请不存在');
    if (wd.status !== 'pending') {
      throw new Error(`当前状态 ${wd.status} 无法驳回`);
    }

    // 解冻 pending_withdrawal_points
    await client.query(
      `UPDATE users
       SET pending_withdrawal_points = GREATEST(0, pending_withdrawal_points - $1)
       WHERE id = $2`,
      [wd.amount_points, wd.creator_id],
    );

    const { rows: updatedRows } = await client.query(
      `UPDATE creator_withdrawals
       SET status = 'rejected',
           reviewed_by = $1,
           reviewed_at = NOW(),
           review_note = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [input.reviewedBy, input.note, input.withdrawalId],
    );

    await client.query('COMMIT');
    return updatedRows[0] as CreatorWithdrawalRow;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function markWithdrawalPaid(input: {
  withdrawalId: string;
  paymentProof: string;
}): Promise<CreatorWithdrawalRow> {
  const { rows } = await pool.query(
    `UPDATE creator_withdrawals
     SET status = 'paid',
         paid_at = NOW(),
         payment_proof = $1,
         updated_at = NOW()
     WHERE id = $2 AND status = 'approved'
     RETURNING *`,
    [input.paymentProof, input.withdrawalId],
  );
  if (rows.length === 0) {
    throw new Error('提现申请不存在或状态不是已批准');
  }
  return rows[0] as CreatorWithdrawalRow;
}

/**
 * 管理员调整用户的充值积分（purchased_points）。
 * 负数时会被 reserved_points 兜底拦截，避免把可用积分打成负。
 */
export async function adjustUserPurchasedPoints(
  userId: string,
  amountPoints: number,
  note?: string | null,
): Promise<User> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await getUserByIdUsing(client, userId, {
      forUpdate: true,
    });
    if (!user) {
      throw new Error('用户不存在');
    }

    const nextPurchased = user.purchased_points + amountPoints;
    if (nextPurchased < 0) {
      throw new Error('积分不足，无法完成本次调整');
    }
    const spendable = nextPurchased + user.bonus_points;
    if (spendable < user.reserved_points) {
      throw new Error('可用积分不足以覆盖已预扣，无法完成调整');
    }

    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET purchased_points = $1
       WHERE id = $2
       RETURNING *`,
      [nextPurchased, userId],
    );

    await insertWalletTransaction(client, {
      userId,
      kind: amountPoints >= 0 ? 'manual_topup' : 'manual_adjustment',
      amountPoints,
      pointSource: 'purchased',
      note: note ?? null,
      metadata: { source: 'admin' },
    });

    await client.query('COMMIT');
    return updatedRows[0] as User;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 请求级预扣：锁定用户积分避免并发超额。
 * 可用积分（purchased + bonus - reserved）决定本次预扣上限。
 * 幂等：同一 requestId 已存在时直接返回现有预留。
 */
export async function reserveUserPoints(input: {
  userId: string;
  amountPoints: number;
  requestId: string;
  yearMonth: string;
  modelConfigId?: string | null;
  note?: string | null;
  metadata?: unknown;
}): Promise<{ user: User; reservedPoints: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existingRows } = await client.query(
      'SELECT * FROM billing_request_reservations WHERE request_id = $1 FOR UPDATE',
      [input.requestId],
    );
    const existing = existingRows[0] as
      | BillingRequestReservationRow
      | undefined;
    if (existing) {
      const existingUser = await getUserByIdUsing(client, existing.user_id, {
        forUpdate: true,
      });
      if (!existingUser) {
        throw new Error('用户不存在');
      }
      await client.query('COMMIT');
      return {
        user: existingUser,
        reservedPoints: existing.reserved_points,
      };
    }

    const user = await getUserByIdUsing(client, input.userId, {
      forUpdate: true,
    });
    if (!user) {
      throw new Error('用户不存在');
    }

    const reservableHeadroom = calculateAvailableSpendablePoints(user);
    if (input.amountPoints > 0 && reservableHeadroom <= 0) {
      throw new Error('余额不足，请充值后继续使用');
    }

    const actualReservedPoints = Math.min(
      Math.max(0, input.amountPoints),
      reservableHeadroom,
    );
    const holdState: BillingRequestReservationRow['hold_state'] =
      actualReservedPoints > 0 ? 'held' : 'none';

    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET reserved_points = reserved_points + $1
       WHERE id = $2
       RETURNING *`,
      [actualReservedPoints, input.userId],
    );

    await insertBillingRequestReservation(client, {
      requestId: input.requestId,
      userId: input.userId,
      modelConfigId: input.modelConfigId ?? null,
      yearMonth: input.yearMonth,
      reservedPoints: actualReservedPoints,
      holdState,
      note: input.note ?? null,
      metadata: input.metadata,
    });

    await client.query('COMMIT');
    return {
      user: updatedRows[0] as User,
      reservedPoints: actualReservedPoints,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function releaseUserReservation(
  requestId: string,
  note?: string | null,
  metadata?: unknown,
): Promise<User> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: reservationRows } = await client.query(
      `SELECT * FROM billing_request_reservations
       WHERE request_id = $1
       FOR UPDATE`,
      [requestId],
    );
    const reservation = reservationRows[0] as
      | BillingRequestReservationRow
      | undefined;
    if (!reservation) {
      throw new Error('预留记录不存在');
    }
    const user = await getUserByIdUsing(client, reservation.user_id, {
      forUpdate: true,
    });
    if (!user) {
      throw new Error('用户不存在');
    }

    const releasable =
      reservation.hold_state === 'held' ? reservation.reserved_points : 0;
    const nextReservedPoints = Math.max(0, user.reserved_points - releasable);
    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET reserved_points = $1
       WHERE id = $2
       RETURNING *`,
      [nextReservedPoints, reservation.user_id],
    );

    await client.query(
      `UPDATE billing_request_reservations
       SET hold_state = CASE WHEN hold_state = 'held' THEN 'released' ELSE hold_state END,
           released_at = CASE WHEN hold_state = 'held' THEN NOW() ELSE released_at END,
           note = COALESCE($2, note),
           metadata = COALESCE($3, metadata),
           updated_at = NOW()
       WHERE request_id = $1`,
      [requestId, note ?? null, metadata ? JSON.stringify(metadata) : null],
    );

    // 不再插入释放流水记录，只有实际扣费才记录到 wallet_transactions

    await client.query('COMMIT');
    return updatedRows[0] as User;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function settleUserModelChargePoints(
  requestId: string,
  requestTokens: number,
  requestCostPoints: number,
): Promise<{ actualChargePoints: number; user: User }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: reservationRows } = await client.query(
      `SELECT * FROM billing_request_reservations
       WHERE request_id = $1
       FOR UPDATE`,
      [requestId],
    );
    const reservation = reservationRows[0] as
      | BillingRequestReservationRow
      | undefined;
    if (!reservation) {
      throw new Error('预留记录不存在');
    }
    if (reservation.charge_state === 'charged') {
      const existingUser = await getUserByIdUsing(client, reservation.user_id, {
        forUpdate: true,
      });
      if (!existingUser) {
        throw new Error('用户不存在');
      }
      await client.query('COMMIT');
      return {
        actualChargePoints: reservation.actual_charge_points,
        user: existingUser,
      };
    }

    // per-user advisory lock：明确串行化同一用户的所有结算，避免并发结算
    // 在 INSERT...ON CONFLICT 与 SELECT FOR UPDATE 之间窗口被竞争利用。
    // hashtext 把 TEXT user_id 映射为 int，匹配 advisory_xact_lock(int) 签名。
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('billing:settle:' || $1))",
      [reservation.user_id],
    );

    const user = await getUserByIdUsing(client, reservation.user_id, {
      forUpdate: true,
    });
    if (!user) {
      throw new Error('用户不存在');
    }

    await client.query(
      `INSERT INTO monthly_billing_state
        (user_id, year_month, billed_overage_tokens, billed_overage_cost_points, updated_at)
       VALUES ($1, $2, 0, 0, NOW())
       ON CONFLICT (user_id, year_month)
       DO UPDATE SET updated_at = monthly_billing_state.updated_at
       RETURNING *`,
      [reservation.user_id, reservation.year_month],
    );

    const actualChargePoints = Math.max(0, requestCostPoints);
    const releasedReservedPoints =
      reservation.hold_state === 'held' ? reservation.reserved_points : 0;
    const nextReservedPoints = Math.max(
      0,
      user.reserved_points - releasedReservedPoints,
    );

    // bonus → purchased 优先级扣减（内部更新 bonus_points / purchased_points）
    const deduction = await deductPoints(client, user, actualChargePoints, {
      releasedReservedPoints,
    });

    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET reserved_points = $1
       WHERE id = $2
       RETURNING *`,
      [nextReservedPoints, reservation.user_id],
    );

    await client.query(
      `UPDATE monthly_billing_state
       SET billed_overage_tokens = billed_overage_tokens + $1,
           billed_overage_cost_points = billed_overage_cost_points + $2,
           updated_at = NOW()
       WHERE user_id = $3 AND year_month = $4`,
      [
        requestTokens,
        actualChargePoints,
        reservation.user_id,
        reservation.year_month,
      ],
    );

    await client.query(
      `UPDATE billing_request_reservations
       SET hold_state = CASE WHEN hold_state = 'held' THEN 'released' ELSE hold_state END,
          charge_state = 'charged',
           actual_charge_points = $2,
           total_overage_tokens = $3,
           total_overage_cost_points = $4,
           released_at = CASE WHEN hold_state = 'held' THEN NOW() ELSE released_at END,
           charged_at = NOW(),
           updated_at = NOW()
       WHERE request_id = $1`,
      [requestId, actualChargePoints, requestTokens, actualChargePoints],
    );

    if (reservation.hold_state === 'held' && reservation.reserved_points > 0) {
      await insertWalletTransaction(client, {
        userId: reservation.user_id,
        kind: 'reservation_release',
        reservedDeltaPoints: -reservation.reserved_points,
        requestId,
        note: '请求完成，释放预扣额度',
      });
    }

    if (actualChargePoints > 0) {
      // 每个命中的赠送批次写一行流水（批次级溯源）
      for (const bd of deduction.batchDeductions) {
        await insertWalletTransaction(client, {
          userId: reservation.user_id,
          kind: 'overage_charge',
          amountPoints: -bd.points,
          pointSource: 'bonus',
          pointBatchId: bd.batchId,
          requestId,
          note: '官方模型 Token 扣费（赠送积分批次）',
          metadata: {
            yearMonth: reservation.year_month,
            batchId: bd.batchId,
            requestTokens,
            requestCostPoints,
          },
        });
      }
      // 从 purchased 兜底扣的部分写一条汇总流水
      if (deduction.purchasedDeducted > 0) {
        await insertWalletTransaction(client, {
          userId: reservation.user_id,
          kind: 'overage_charge',
          amountPoints: -deduction.purchasedDeducted,
          pointSource: 'purchased',
          requestId,
          note: '官方模型 Token 扣费',
          metadata: {
            yearMonth: reservation.year_month,
            requestTokens,
            requestCostPoints,
            bonusDeducted: deduction.bonusDeducted,
            purchasedDeducted: deduction.purchasedDeducted,
          },
        });
      }
    }

    await client.query('COMMIT');
    return {
      actualChargePoints,
      user: updatedRows[0] as User,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getAccountsByUserId(userId: string): Promise<Account[]> {
  const { rows } = await pool.query(
    'SELECT * FROM accounts WHERE owner_id = $1 ORDER BY created_at',
    [userId],
  );
  return rows as Account[];
}

export async function bindAccountToUser(
  accountId: string,
  userId: string,
): Promise<void> {
  await pool.query('UPDATE accounts SET owner_id = $1 WHERE id = $2', [
    userId,
    accountId,
  ]);
}

// =====================
// --- Official skill global config ---
// =====================

export interface SkillGlobalConfig {
  skill_name: string;
  globally_enabled: boolean;
  default_enabled: boolean;
  updated_at: string;
  updated_by: string | null;
}

/** 返回所有后台全局开启的官方 Skill 名称列表 */
export async function getGloballyEnabledSkillNames(): Promise<string[]> {
  const { rows } = await pool.query(
    'SELECT skill_name FROM skill_global_config WHERE globally_enabled = true ORDER BY skill_name',
  );
  return (rows as { skill_name: string }[]).map((r) => r.skill_name);
}

/** 获取所有官方 Skill 的全局配置（含开关状态和默认启用状态） */
export async function getAllSkillGlobalConfigs(): Promise<SkillGlobalConfig[]> {
  const { rows } = await pool.query(
    'SELECT skill_name, globally_enabled, default_enabled, updated_at, updated_by FROM skill_global_config ORDER BY skill_name',
  );
  return rows as SkillGlobalConfig[];
}

/** 后台设置官方 Skill 的全局开关 */
export async function setSkillGlobalEnabled(
  skillName: string,
  enabled: boolean,
): Promise<void> {
  await pool.query(
    'UPDATE skill_global_config SET globally_enabled = $1, updated_at = NOW() WHERE skill_name = $2',
    [enabled, skillName],
  );
}

/** 后台设置官方 Skill 的默认启用状态（新用户的默认值） */
export async function setSkillDefaultEnabled(
  skillName: string,
  defaultEnabled: boolean,
): Promise<void> {
  await pool.query(
    'UPDATE skill_global_config SET default_enabled = $1, updated_at = NOW() WHERE skill_name = $2',
    [defaultEnabled, skillName],
  );
}

/**
 * 将官方 Skill 列表同步到 skill_global_config 表。
 * 使用 ON CONFLICT DO NOTHING，已有的条目（含开关状态）不会被覆盖。
 * 在读取 skill catalog 或后台管理接口时调用，确保新增的官方 Skill 自动入库。
 */
export async function seedOfficialSkills(skillNames: string[]): Promise<void> {
  if (skillNames.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const name of skillNames) {
      await client.query(
        `INSERT INTO skill_global_config (skill_name, globally_enabled, updated_at)
         VALUES ($1, true, NOW())
         ON CONFLICT (skill_name) DO NOTHING`,
        [name],
      );
    }
    // 清理已不存在的旧 skill 记录
    if (skillNames.length > 0) {
      const placeholders = skillNames.map((_, i) => `$${i + 1}`).join(',');
      await client.query(
        `DELETE FROM user_skills WHERE skill_name NOT IN (${placeholders})`,
        skillNames,
      );
      await client.query(
        `DELETE FROM skill_global_config WHERE skill_name NOT IN (${placeholders})`,
        skillNames,
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// =====================
// --- User skill accessors ---
// =====================

export async function getUserSkills(userId: string): Promise<UserSkill[]> {
  const { rows } = await pool.query(
    'SELECT * FROM user_skills WHERE user_id = $1 AND deleted_at IS NULL',
    [userId],
  );
  return rows as UserSkill[];
}

export async function getEnabledSkillNames(userId: string): Promise<string[]> {
  const { rows } = await pool.query(
    'SELECT skill_name FROM user_skills WHERE user_id = $1 AND enabled = true AND deleted_at IS NULL',
    [userId],
  );
  return (rows as { skill_name: string }[]).map((r) => r.skill_name);
}

/**
 * 解析用户当前可用的官方 Skill 名称列表。
 * 规则与 agent-runner 保持一致：先看全局开关，再叠加用户显式开关，
 * 用户未设置时回退到 default_enabled。
 */
export async function getResolvedEnabledOfficialSkillNames(
  userId?: string,
): Promise<string[]> {
  if (userId) {
    const { rows } = await pool.query(
      `SELECT sgc.skill_name FROM skill_global_config sgc
       LEFT JOIN user_skills us
         ON us.skill_name = sgc.skill_name
        AND us.user_id = $1
        AND us.deleted_at IS NULL
       WHERE sgc.globally_enabled = true
         AND COALESCE(us.enabled, sgc.default_enabled) = true
       ORDER BY sgc.skill_name`,
      [userId],
    );
    return (rows as { skill_name: string }[]).map((row) => row.skill_name);
  }

  const { rows } = await pool.query(
    `SELECT skill_name FROM skill_global_config
     WHERE globally_enabled = true
       AND default_enabled = true
     ORDER BY skill_name`,
  );
  return (rows as { skill_name: string }[]).map((row) => row.skill_name);
}

export async function enableUserSkill(
  userId: string,
  skillName: string,
): Promise<void> {
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO user_skills (user_id, skill_name, enabled, enabled_at)
     VALUES ($1, $2, true, $3)
     ON CONFLICT (user_id, skill_name) DO UPDATE SET enabled = true, enabled_at = $3, deleted_at = NULL`,
    [userId, skillName, now],
  );
}

export async function disableUserSkill(
  userId: string,
  skillName: string,
): Promise<void> {
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO user_skills (user_id, skill_name, enabled, enabled_at)
     VALUES ($1, $2, false, $3)
     ON CONFLICT (user_id, skill_name) DO UPDATE SET enabled = false, deleted_at = NULL`,
    [userId, skillName, now],
  );
}

export async function enableAllUserSkills(
  userId: string,
  skillNames: string[],
): Promise<void> {
  const now = new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const name of skillNames) {
      await client.query(
        `INSERT INTO user_skills (user_id, skill_name, enabled, enabled_at)
         VALUES ($1, $2, true, $3)
         ON CONFLICT (user_id, skill_name) DO UPDATE SET enabled = true, enabled_at = $3, deleted_at = NULL`,
        [userId, name, now],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function disableAllUserSkills(userId: string): Promise<void> {
  await pool.query(
    'UPDATE user_skills SET enabled = false WHERE user_id = $1 AND deleted_at IS NULL',
    [userId],
  );
}

export async function getMonthlyModelChargePoints(
  userId: string,
  yearMonth?: string,
): Promise<number> {
  const ym = yearMonth ?? new Date().toISOString().slice(0, 7);
  const { rows } = await pool.query(
    `SELECT COALESCE(billed_overage_cost_points, 0) AS total
     FROM monthly_billing_state
     WHERE user_id = $1 AND year_month = $2`,
    [userId, ym],
  );
  return Number(
    (rows[0] as { total: string | number } | undefined)?.total ?? 0,
  );
}

/**
 * 重置用户的所有数据：消息、定时任务（含运行日志）、技能配置。
 * 使用软删除（标记 deleted_at）而非物理删除，以满足审查要求。
 */
export async function resetUserData(userId: string): Promise<string[]> {
  const now = new Date().toISOString();
  const userAccounts = await getAccountsByUserId(userId);
  const accountIds = userAccounts.map((a) => a.id);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const accountId of accountIds) {
      await client.query(
        `UPDATE task_run_logs SET deleted_at = $1 WHERE deleted_at IS NULL AND task_id IN
         (SELECT id FROM scheduled_tasks WHERE account_id = $2)`,
        [now, accountId],
      );
      await client.query(
        'UPDATE scheduled_tasks SET deleted_at = $1 WHERE account_id = $2 AND deleted_at IS NULL',
        [now, accountId],
      );
      await client.query(
        'UPDATE messages SET deleted_at = $1 WHERE account_id = $2 AND deleted_at IS NULL',
        [now, accountId],
      );
    }

    await client.query(
      'UPDATE user_skills SET deleted_at = $1 WHERE user_id = $2 AND deleted_at IS NULL',
      [now, userId],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return accountIds;
}

export async function resetUserMessages(userId: string): Promise<string[]> {
  const now = new Date().toISOString();
  const userAccounts = await getAccountsByUserId(userId);
  const accountIds = userAccounts.map((a) => a.id);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const accountId of accountIds) {
      await client.query(
        'UPDATE messages SET deleted_at = $1 WHERE account_id = $2 AND deleted_at IS NULL',
        [now, accountId],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return accountIds;
}

export async function resetUserTasks(userId: string): Promise<string[]> {
  const now = new Date().toISOString();
  const userAccounts = await getAccountsByUserId(userId);
  const accountIds = userAccounts.map((a) => a.id);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const accountId of accountIds) {
      await client.query(
        `UPDATE task_run_logs SET deleted_at = $1 WHERE deleted_at IS NULL AND task_id IN
         (SELECT id FROM scheduled_tasks WHERE account_id = $2)`,
        [now, accountId],
      );
      await client.query(
        'UPDATE scheduled_tasks SET deleted_at = $1 WHERE account_id = $2 AND deleted_at IS NULL',
        [now, accountId],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return accountIds;
}

export async function resetUserSkills(userId: string): Promise<void> {
  const now = new Date().toISOString();
  await pool.query(
    'UPDATE user_skills SET deleted_at = $1 WHERE user_id = $2 AND deleted_at IS NULL',
    [now, userId],
  );
}

export async function getActiveTaskCountForUser(
  userId: string,
): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*) as cnt FROM scheduled_tasks t
     JOIN accounts a ON a.id = t.account_id
     WHERE a.owner_id = $1 AND t.status = 'active' AND t.deleted_at IS NULL`,
    [userId],
  );
  return Number((rows[0] as { cnt: string }).cnt);
}

// =====================
// --- Admin global stats ---
// =====================

export interface AdminGlobalStats {
  total_users: number;
  plan_distribution: { plan: string; count: number }[];
  model_selection_distribution: { source: string; count: number }[];
  active_subscriptions: number;
  total_recharge_orders: number;
  paid_recharge_orders: number;
  pending_recharge_orders: number;
  total_recharge_points: number;
  total_recharge_yuan: string;
  today_recharge_points: number;
  today_recharge_yuan: string;
  total_accounts: number;
  enabled_accounts: number;
  total_messages: number;
  total_input_tokens: number;
  total_output_tokens: number;
  today_messages: number;
  today_input_tokens: number;
  today_output_tokens: number;
  active_tasks: number;
  recent_signups_7d: number;
  recharge_period: AdminRechargePeriodStats;
}

export type AdminRechargeStatsRange =
  | 'today'
  | '7d'
  | '30d'
  | 'month'
  | 'custom'
  | 'all';

export interface AdminRechargePeriodStats {
  range: AdminRechargeStatsRange;
  label: string;
  start_date: string | null;
  end_date: string | null;
  paid_orders: number;
  total_recharge_points: number;
  total_recharge_yuan: string;
}

// =====================
// --- Admin query accessors ---
// =====================

export interface AdminMessageRow {
  id: string;
  account_id: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message: boolean;
  session_id: string | null;
  session_title: string | null;
  deleted_at: string | null;
  session_deleted_at: string | null;
}

export async function getMessagesForAdmin(opts: {
  accountId?: string;
  userId?: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ messages: AdminMessageRow[]; total: number }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  let whereClause = 'WHERE 1=1';
  const params: unknown[] = [];
  let paramIdx = 1;

  if (opts.accountId) {
    whereClause += ` AND m.account_id = $${paramIdx++}`;
    params.push(opts.accountId);
  } else if (opts.userId) {
    whereClause += ` AND (
      m.user_id = $${paramIdx}
      OR m.account_id IN (SELECT id FROM accounts WHERE owner_id = $${paramIdx})
      OR EXISTS (
        SELECT 1 FROM chat_sessions s
        WHERE s.id = m.session_id AND s.user_id = $${paramIdx}
      )
    )`;
    params.push(opts.userId);
    paramIdx++;
  }
  if (opts.sessionId) {
    whereClause += ` AND m.session_id = $${paramIdx++}`;
    params.push(opts.sessionId);
  }

  const countQuery = `SELECT COUNT(*) as cnt FROM messages m ${whereClause}`;
  const { rows: countRows } = await pool.query(countQuery, params);
  const total = Number((countRows[0] as { cnt: string }).cnt);

  const dataQuery = `SELECT m.id, m.account_id, m.sender, m.sender_name, m.content, m.timestamp, m.is_from_me, m.is_bot_message,
      m.session_id, s.title AS session_title, m.deleted_at, s.deleted_at AS session_deleted_at
    FROM messages m
    LEFT JOIN chat_sessions s ON s.id = m.session_id
    ${whereClause}
    ORDER BY (m.deleted_at IS NOT NULL) ASC, m.timestamp DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
  const { rows } = await pool.query(dataQuery, [...params, limit, offset]);

  return { messages: rows as AdminMessageRow[], total };
}

export interface AdminChatSessionRow {
  id: string;
  account_id: string;
  account_name: string;
  owner_user_id: string | null;
  owner_phone: string | null;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message_at: string | null;
  last_message_preview: string | null;
  deleted_at: string | null;
}

export async function getChatSessionsForAdmin(opts: {
  accountId?: string;
  userId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ sessions: AdminChatSessionRow[]; total: number }> {
  const limit = Math.min(opts.limit ?? 100, 200);
  const offset = opts.offset ?? 0;

  let whereClause = 'WHERE 1=1';
  const params: unknown[] = [];
  let paramIdx = 1;

  if (opts.accountId) {
    whereClause += ` AND s.account_id = $${paramIdx++}`;
    params.push(opts.accountId);
  } else if (opts.userId) {
    whereClause += ` AND COALESCE(s.user_id, a.owner_id) = $${paramIdx++}`;
    params.push(opts.userId);
  }

  const countQuery = `SELECT COUNT(*) AS cnt
    FROM chat_sessions s
    LEFT JOIN accounts a ON a.id = s.account_id
    ${whereClause}`;
  const { rows: countRows } = await pool.query(countQuery, params);
  const total = Number((countRows[0] as { cnt: string }).cnt);

  const dataQuery = `SELECT s.id,
      s.account_id,
      COALESCE(a.name, CASE WHEN s.account_id LIKE 'web:%' THEN '站内 AI Chat' ELSE s.account_id END) AS account_name,
      COALESCE(s.user_id, a.owner_id) AS owner_user_id,
      u.phone AS owner_phone,
      s.title,
      s.created_at,
      s.updated_at,
      s.deleted_at,
      COALESCE(mc.message_count, 0)::int AS message_count,
      lm.last_message_at,
      lm.last_message_preview
    FROM chat_sessions s
    LEFT JOIN accounts a ON a.id = s.account_id
    LEFT JOIN users u ON u.id = COALESCE(s.user_id, a.owner_id)
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS message_count
      FROM messages m
      WHERE m.session_id = s.id
    ) mc ON true
    LEFT JOIN LATERAL (
      SELECT m.timestamp AS last_message_at,
        LEFT(m.content, 160) AS last_message_preview
      FROM messages m
      WHERE m.session_id = s.id
      ORDER BY m.timestamp DESC
      LIMIT 1
    ) lm ON true
    ${whereClause}
    ORDER BY (s.deleted_at IS NOT NULL) ASC, COALESCE(lm.last_message_at, s.updated_at) DESC
    LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
  const { rows } = await pool.query(dataQuery, [...params, limit, offset]);

  return { sessions: rows as AdminChatSessionRow[], total };
}

export interface AdminTaskRow {
  id: string;
  account_id: string;
  account_name: string;
  owner_phone: string | null;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  reminder_type: string | null;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: string;
  created_at: string;
}

export async function getTasksForAdmin(opts: {
  userId?: string;
  status?: string;
  limit?: number;
}): Promise<AdminTaskRow[]> {
  let whereClause = 'WHERE t.deleted_at IS NULL';
  const params: unknown[] = [];
  let paramIdx = 1;

  if (opts.userId) {
    whereClause += ` AND a.owner_id = $${paramIdx++}`;
    params.push(opts.userId);
  }
  if (opts.status) {
    whereClause += ` AND t.status = $${paramIdx++}`;
    params.push(opts.status);
  }
  // 上限默认 500，admin 视角通常按 user/status 过滤
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT t.id, t.account_id, a.name as account_name, u.phone as owner_phone,
            t.prompt, t.schedule_type, t.schedule_value, t.reminder_type,
            t.next_run, t.last_run, t.last_result, t.status, t.created_at
     FROM scheduled_tasks t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN users u ON u.id = a.owner_id
     ${whereClause}
     ORDER BY t.created_at DESC
     LIMIT $${paramIdx}`,
    params,
  );

  return rows as AdminTaskRow[];
}

export interface AdminSkillRow {
  user_id: string;
  phone: string;
  skill_name: string;
  enabled: boolean;
  enabled_at: string;
}

export async function getSkillsForAdmin(opts: {
  userId?: string;
}): Promise<AdminSkillRow[]> {
  let whereClause = 'WHERE s.deleted_at IS NULL';
  const params: unknown[] = [];
  let paramIdx = 1;

  if (opts.userId) {
    whereClause += ` AND s.user_id = $${paramIdx++}`;
    params.push(opts.userId);
  }

  const { rows } = await pool.query(
    `SELECT s.user_id, u.phone, s.skill_name, s.enabled, s.enabled_at
     FROM user_skills s
     JOIN users u ON u.id = s.user_id
     ${whereClause}
     ORDER BY s.enabled_at DESC`,
    params,
  );

  return rows as AdminSkillRow[];
}

export interface AdminCustomSkillRow {
  id: string;
  user_id: string;
  phone: string;
  skill_name: string;
  description: string;
  trigger_hint: string;
  content: string;
  category: string;
  match_keywords: string[];
  usage_mode: 'force_injected' | 'reference_only';
  visibility: 'private' | 'link_shared' | 'shared';
  share_token: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export async function getCustomSkillsForAdmin(opts: {
  userId?: string;
}): Promise<AdminCustomSkillRow[]> {
  let whereClause = 'WHERE s.deleted_at IS NULL';
  const params: unknown[] = [];
  let paramIdx = 1;

  if (opts.userId) {
    whereClause += ` AND s.user_id = $${paramIdx++}`;
    params.push(opts.userId);
  }

  const { rows } = await pool.query(
    `SELECT s.id, s.user_id, u.phone, s.skill_name, s.description,
            s.trigger_hint, COALESCE(sc.content, '') AS content, s.category, s.match_keywords,
            s.usage_mode, s.visibility, s.share_token, s.enabled,
            s.created_at, s.updated_at
     FROM user_custom_skills s
     LEFT JOIN user_custom_skill_contents sc ON sc.skill_id = s.id
     JOIN users u ON u.id = s.user_id
     ${whereClause}
     ORDER BY s.created_at DESC`,
    params,
  );

  return rows as AdminCustomSkillRow[];
}

export async function getCustomSkillForAdmin(
  id: string,
): Promise<AdminCustomSkillRow | undefined> {
  const { rows } = await pool.query(
    `SELECT s.id, s.user_id, u.phone, s.skill_name, s.description,
            s.trigger_hint, COALESCE(sc.content, '') AS content, s.category, s.match_keywords,
            s.usage_mode, s.visibility, s.share_token, s.enabled,
            s.created_at, s.updated_at
     FROM user_custom_skills s
     LEFT JOIN user_custom_skill_contents sc ON sc.skill_id = s.id
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [id],
  );
  return rows[0] as AdminCustomSkillRow | undefined;
}

function dateOnlyFromOffset(baseDate: Date, offsetDays: number): string {
  const date = new Date(
    Date.UTC(
      baseDate.getUTCFullYear(),
      baseDate.getUTCMonth(),
      baseDate.getUTCDate() + offsetDays,
    ),
  );
  return date.toISOString().slice(0, 10);
}

function firstDateOfCurrentMonth(baseDate: Date): string {
  return new Date(
    Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), 1),
  )
    .toISOString()
    .slice(0, 10);
}

function resolveAdminRechargePeriod(opts: {
  range?: AdminRechargeStatsRange;
  startDate?: string;
  endDate?: string;
}): {
  range: AdminRechargeStatsRange;
  label: string;
  startDate: string | null;
  endDate: string | null;
  endExclusiveDate: string | null;
} {
  const now = new Date();
  const today = dateOnlyFromOffset(now, 0);

  if (opts.startDate && opts.endDate) {
    return {
      range: 'custom',
      label: `${opts.startDate} 至 ${opts.endDate}`,
      startDate: opts.startDate,
      endDate: opts.endDate,
      endExclusiveDate: dateOnlyFromOffset(
        new Date(`${opts.endDate}T00:00:00.000Z`),
        1,
      ),
    };
  }

  const selectedRange = opts.range ?? 'all';

  if (selectedRange === 'today') {
    return {
      range: selectedRange,
      label: '今日',
      startDate: today,
      endDate: today,
      endExclusiveDate: dateOnlyFromOffset(now, 1),
    };
  }

  if (selectedRange === '7d') {
    const startDate = dateOnlyFromOffset(now, -6);
    return {
      range: selectedRange,
      label: '近 7 天',
      startDate,
      endDate: today,
      endExclusiveDate: dateOnlyFromOffset(now, 1),
    };
  }

  if (selectedRange === '30d') {
    const startDate = dateOnlyFromOffset(now, -29);
    return {
      range: selectedRange,
      label: '近 30 天',
      startDate,
      endDate: today,
      endExclusiveDate: dateOnlyFromOffset(now, 1),
    };
  }

  if (selectedRange === 'month') {
    return {
      range: selectedRange,
      label: '本月',
      startDate: firstDateOfCurrentMonth(now),
      endDate: today,
      endExclusiveDate: dateOnlyFromOffset(now, 1),
    };
  }

  return {
    range: 'all',
    label: '累计',
    startDate: null,
    endDate: null,
    endExclusiveDate: null,
  };
}

export async function getAdminGlobalStats(
  opts: {
    rechargeRange?: AdminRechargeStatsRange;
    rechargeStartDate?: string;
    rechargeEndDate?: string;
  } = {},
): Promise<AdminGlobalStats> {
  const today = new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const rechargePeriod = resolveAdminRechargePeriod({
    range: opts.rechargeRange,
    startDate: opts.rechargeStartDate,
    endDate: opts.rechargeEndDate,
  });
  const rechargeStatsParams = [
    today,
    rechargePeriod.startDate,
    rechargePeriod.endExclusiveDate,
  ];

  const [
    userCount,
    modelSelectionDist,
    accountStats,
    totalUsage,
    todayUsage,
    taskCount,
    recentSignups,
    rechargeStats,
  ] = await Promise.all([
    pool.query('SELECT COUNT(*) as cnt FROM users'),
    pool.query(
      `SELECT COALESCE(sel.source, 'unselected') as model_source, COUNT(*) as count
       FROM users u
       LEFT JOIN user_model_selections sel ON sel.user_id = u.id
       GROUP BY COALESCE(sel.source, 'unselected')
       ORDER BY count DESC`,
    ),
    pool.query(
      `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE enabled = true) as enabled
       FROM accounts`,
    ),
    pool.query(
      `SELECT COALESCE(SUM(msg_count), 0) as msgs, COALESCE(SUM(input_tokens), 0) as inp, COALESCE(SUM(output_tokens), 0) as outp FROM daily_usage`,
    ),
    pool.query(
      `SELECT COALESCE(SUM(msg_count), 0) as msgs, COALESCE(SUM(input_tokens), 0) as inp, COALESCE(SUM(output_tokens), 0) as outp FROM daily_usage WHERE date = $1`,
      [today],
    ),
    pool.query(
      `SELECT COUNT(*) as cnt FROM scheduled_tasks WHERE status = 'active' AND deleted_at IS NULL`,
    ),
    pool.query(`SELECT COUNT(*) as cnt FROM users WHERE created_at >= $1`, [
      sevenDaysAgo,
    ]),
    pool.query(
      `SELECT
         COUNT(*)::int AS total_orders,
         COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_orders,
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_orders,
         COALESCE(SUM(amount_points) FILTER (WHERE status = 'paid'), 0)::int
           AS total_points,
         COALESCE(SUM(amount_yuan) FILTER (WHERE status = 'paid'), 0)::text
           AS total_yuan,
         COALESCE(SUM(amount_points) FILTER (
           WHERE status = 'paid' AND paid_at >= $1::date
         ), 0)::int AS today_points,
         COALESCE(SUM(amount_yuan) FILTER (
           WHERE status = 'paid'
             AND paid_at >= $1::date
             AND paid_at < ($1::date + INTERVAL '1 day')
         ), 0)::text AS today_yuan,
         COUNT(*) FILTER (
           WHERE status = 'paid'
             AND ($2::date IS NULL OR paid_at >= $2::date)
             AND ($3::date IS NULL OR paid_at < $3::date)
         )::int AS period_paid_orders,
         COALESCE(SUM(amount_points) FILTER (
           WHERE status = 'paid'
             AND ($2::date IS NULL OR paid_at >= $2::date)
             AND ($3::date IS NULL OR paid_at < $3::date)
         ), 0)::int AS period_points,
         COALESCE(SUM(amount_yuan) FILTER (
           WHERE status = 'paid'
             AND ($2::date IS NULL OR paid_at >= $2::date)
             AND ($3::date IS NULL OR paid_at < $3::date)
         ), 0)::text AS period_yuan
       FROM recharge_orders`,
      rechargeStatsParams,
    ),
  ]);

  const acc = accountStats.rows[0] as { total: string; enabled: string };
  const tu = totalUsage.rows[0] as { msgs: string; inp: string; outp: string };
  const td = todayUsage.rows[0] as { msgs: string; inp: string; outp: string };
  const rs = rechargeStats.rows[0] as {
    total_orders: number;
    paid_orders: number;
    pending_orders: number;
    total_points: number;
    total_yuan: string;
    today_points: number;
    today_yuan: string;
    period_paid_orders: number;
    period_points: number;
    period_yuan: string;
  };

  const modelSelectionDistribution = (
    modelSelectionDist.rows as { model_source: string; count: string }[]
  ).map((r) => ({
    source: r.model_source,
    count: Number(r.count),
  }));

  return {
    total_users: Number((userCount.rows[0] as { cnt: string }).cnt),
    model_selection_distribution: modelSelectionDistribution,
    plan_distribution: modelSelectionDistribution.map((r) => ({
      plan: r.source,
      count: r.count,
    })),
    active_subscriptions: 0,
    total_recharge_orders: Number(rs.total_orders),
    paid_recharge_orders: Number(rs.paid_orders),
    pending_recharge_orders: Number(rs.pending_orders),
    total_recharge_points: Number(rs.total_points),
    total_recharge_yuan: rs.total_yuan,
    today_recharge_points: Number(rs.today_points),
    today_recharge_yuan: rs.today_yuan,
    recharge_period: {
      range: rechargePeriod.range,
      label: rechargePeriod.label,
      start_date: rechargePeriod.startDate,
      end_date: rechargePeriod.endDate,
      paid_orders: Number(rs.period_paid_orders),
      total_recharge_points: Number(rs.period_points),
      total_recharge_yuan: rs.period_yuan,
    },
    total_accounts: Number(acc.total),
    enabled_accounts: Number(acc.enabled),
    total_messages: Number(tu.msgs),
    total_input_tokens: Number(tu.inp),
    total_output_tokens: Number(tu.outp),
    today_messages: Number(td.msgs),
    today_input_tokens: Number(td.inp),
    today_output_tokens: Number(td.outp),
    active_tasks: Number((taskCount.rows[0] as { cnt: string }).cnt),
    recent_signups_7d: Number((recentSignups.rows[0] as { cnt: string }).cnt),
  };
}

// =====================
// --- User custom skill accessors ---
// =====================

export async function createUserCustomSkill(
  skill: Pick<
    UserCustomSkill,
    | 'id'
    | 'user_id'
    | 'skill_name'
    | 'dir_name'
    | 'description'
    | 'trigger_hint'
    | 'content'
    | 'category'
  > &
    Partial<
      Pick<
        UserCustomSkill,
        | 'category_normalized'
        | 'match_keywords'
        | 'match_patterns'
        | 'example_queries'
        | 'priority'
        | 'usage_mode'
      >
    >,
): Promise<UserCustomSkill> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO user_custom_skills
         (id, user_id, skill_name, dir_name, description, trigger_hint, category,
          category_normalized, match_keywords, match_patterns, example_queries, priority, usage_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        skill.id,
        skill.user_id,
        skill.skill_name,
        skill.dir_name,
        skill.description,
        skill.trigger_hint,
        skill.category || '通用',
        skill.category_normalized ?? null,
        JSON.stringify(skill.match_keywords ?? []),
        JSON.stringify(skill.match_patterns ?? []),
        JSON.stringify(skill.example_queries ?? []),
        skill.priority ?? 0,
        skill.usage_mode ?? 'reference_only',
      ],
    );
    await client.query(
      `INSERT INTO user_custom_skill_contents (skill_id, content, updated_at)
       VALUES ($1, $2, NOW())`,
      [skill.id, skill.content],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return (await getUserCustomSkillById(skill.id)) as UserCustomSkill;
}

export async function getUserCustomSkills(
  userId: string,
): Promise<UserCustomSkill[]> {
  const { rows } = await pool.query(
    `SELECT ${USER_CUSTOM_SKILL_SELECT_COLUMNS}
     FROM user_custom_skills s
     LEFT JOIN user_custom_skill_contents sc ON sc.skill_id = s.id
     WHERE s.user_id = $1 AND s.deleted_at IS NULL
     ORDER BY s.created_at DESC`,
    [userId],
  );
  return rows as UserCustomSkill[];
}

export async function getUserCustomSkill(
  id: string,
  userId: string,
): Promise<UserCustomSkill | undefined> {
  const { rows } = await pool.query(
    `SELECT ${USER_CUSTOM_SKILL_SELECT_COLUMNS}
     FROM user_custom_skills s
     LEFT JOIN user_custom_skill_contents sc ON sc.skill_id = s.id
     WHERE s.id = $1 AND s.user_id = $2 AND s.deleted_at IS NULL`,
    [id, userId],
  );
  return rows[0] as UserCustomSkill | undefined;
}

export async function getUserCustomSkillById(
  id: string,
): Promise<UserCustomSkill | undefined> {
  const { rows } = await pool.query(
    `SELECT ${USER_CUSTOM_SKILL_SELECT_COLUMNS}
     FROM user_custom_skills s
     LEFT JOIN user_custom_skill_contents sc ON sc.skill_id = s.id
     WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [id],
  );
  return rows[0] as UserCustomSkill | undefined;
}

export async function updateUserCustomSkill(
  id: string,
  userId: string,
  updates: Partial<
    Pick<
      UserCustomSkill,
      | 'skill_name'
      | 'dir_name'
      | 'description'
      | 'trigger_hint'
      | 'content'
      | 'category'
      | 'category_normalized'
      | 'match_keywords'
      | 'match_patterns'
      | 'example_queries'
      | 'priority'
      | 'usage_mode'
    >
  >,
): Promise<UserCustomSkill | undefined> {
  const skillFields: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;
  let contentValue: string | undefined;

  // JSONB 字段需要 JSON.stringify
  const jsonbFields = new Set([
    'match_keywords',
    'match_patterns',
    'example_queries',
  ]);

  const allowed = [
    'skill_name',
    'dir_name',
    'description',
    'trigger_hint',
    'category',
    'category_normalized',
    'match_keywords',
    'match_patterns',
    'example_queries',
    'priority',
    'usage_mode',
  ] as const;
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      skillFields.push(`${key} = $${paramIdx++}`);
      values.push(
        jsonbFields.has(key) ? JSON.stringify(updates[key]) : updates[key],
      );
    }
  }
  if (updates.content !== undefined) {
    contentValue = updates.content;
  }
  if (skillFields.length === 0 && contentValue === undefined) {
    return getUserCustomSkill(id, userId);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let affected = false;
    if (skillFields.length > 0) {
      skillFields.push(`updated_at = NOW()`);
      values.push(id, userId);
      const result = await client.query(
        `UPDATE user_custom_skills SET ${skillFields.join(', ')}
         WHERE id = $${paramIdx++} AND user_id = $${paramIdx} AND deleted_at IS NULL`,
        values,
      );
      affected = (result.rowCount ?? 0) > 0;
    } else {
      const { rowCount } = await client.query(
        'SELECT 1 FROM user_custom_skills WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
        [id, userId],
      );
      affected = (rowCount ?? 0) > 0;
    }
    if (!affected) {
      await client.query('ROLLBACK');
      return undefined;
    }
    if (contentValue !== undefined) {
      await client.query(
        `INSERT INTO user_custom_skill_contents (skill_id, content, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (skill_id) DO UPDATE SET
           content = EXCLUDED.content,
           updated_at = NOW()`,
        [id, contentValue],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getUserCustomSkill(id, userId);
}

export async function deleteUserCustomSkill(
  id: string,
  userId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    'UPDATE user_custom_skills SET deleted_at = NOW() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function toggleUserCustomSkill(
  id: string,
  userId: string,
): Promise<UserCustomSkill | undefined> {
  const { rowCount } = await pool.query(
    `UPDATE user_custom_skills SET enabled = NOT enabled, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getUserCustomSkill(id, userId);
}

export async function setUserCustomSkillAdminState(
  id: string,
  updates: {
    enabled?: boolean;
    visibility?: UserCustomSkill['visibility'];
    shareToken?: string | null;
  },
): Promise<UserCustomSkill | undefined> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (updates.enabled !== undefined) {
    fields.push(`enabled = $${paramIdx++}`);
    values.push(updates.enabled);
  }

  if (updates.visibility !== undefined) {
    const visibilityParamIdx = paramIdx++;
    values.push(updates.visibility);
    const shareTokenParamIdx = paramIdx++;
    values.push(updates.shareToken ?? null);
    fields.push(`visibility = $${visibilityParamIdx}`);
    fields.push(`share_token = CASE
      WHEN $${visibilityParamIdx} = 'private' THEN NULL
      WHEN $${visibilityParamIdx} IN ('link_shared', 'shared')
        THEN COALESCE(share_token, $${shareTokenParamIdx})
      ELSE share_token
    END`);
  }

  if (fields.length === 0) {
    return getUserCustomSkillById(id);
  }

  fields.push('updated_at = NOW()');
  values.push(id);

  const { rows } = await pool.query(
    `UPDATE user_custom_skills
     SET ${fields.join(', ')}
     WHERE id = $${paramIdx} AND deleted_at IS NULL
     RETURNING id`,
    values,
  );
  if (rows.length === 0) return undefined;
  return getUserCustomSkillById(id);
}

export async function getUserCustomSkillCount(userId: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT COUNT(*) as cnt FROM user_custom_skills WHERE user_id = $1 AND deleted_at IS NULL',
    [userId],
  );
  return Number((rows[0] as { cnt: string }).cnt);
}

// --- Share ---

export async function shareUserCustomSkill(
  id: string,
  userId: string,
  shareToken: string,
): Promise<UserCustomSkill | undefined> {
  const { rowCount } = await pool.query(
    `UPDATE user_custom_skills
     SET visibility = CASE WHEN visibility = 'shared' THEN 'shared' ELSE 'link_shared' END,
         share_token = COALESCE(share_token, $3),
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId, shareToken],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getUserCustomSkill(id, userId);
}

export async function unshareUserCustomSkill(
  id: string,
  userId: string,
): Promise<UserCustomSkill | undefined> {
  const { rowCount } = await pool.query(
    `UPDATE user_custom_skills
     SET visibility = CASE WHEN visibility = 'shared' THEN 'shared' ELSE 'private' END,
         share_token = CASE WHEN visibility = 'shared' THEN share_token ELSE NULL END,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getUserCustomSkill(id, userId);
}

export async function publishUserCustomSkill(
  id: string,
  userId: string,
  shareToken: string,
): Promise<UserCustomSkill | undefined> {
  const { rowCount } = await pool.query(
    `UPDATE user_custom_skills
     SET visibility = 'shared',
         share_token = COALESCE(share_token, $3),
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId, shareToken],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getUserCustomSkill(id, userId);
}

export async function unpublishUserCustomSkill(
  id: string,
  userId: string,
): Promise<UserCustomSkill | undefined> {
  const { rowCount } = await pool.query(
    `UPDATE user_custom_skills
     SET visibility = CASE WHEN share_token IS NULL THEN 'private' ELSE 'link_shared' END,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getUserCustomSkill(id, userId);
}

export async function getSkillByShareToken(
  token: string,
): Promise<UserCustomSkill | undefined> {
  const { rows } = await pool.query(
    `SELECT ${USER_CUSTOM_SKILL_SELECT_COLUMNS}
     FROM user_custom_skills s
     LEFT JOIN user_custom_skill_contents sc ON sc.skill_id = s.id
      WHERE s.share_token = $1 AND s.deleted_at IS NULL AND s.visibility IN ('link_shared', 'shared')`,
    [token],
  );
  return rows[0] as UserCustomSkill | undefined;
}

// --- Subscription ---

export async function subscribeToSkill(
  subscriptionId: string,
  subscriberId: string,
  shareToken: string,
): Promise<UserSkillSubscription | null> {
  // 查找分享的 skill
  const skill = await getSkillByShareToken(shareToken);
  if (!skill) return null;
  // 不能订阅自己的 skill
  if (skill.user_id === subscriberId) return null;

  const { rows } = await pool.query(
    `INSERT INTO user_skill_subscriptions (id, subscriber_id, skill_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (subscriber_id, skill_id) DO UPDATE SET
       enabled = true,
       has_direct_source = true
     RETURNING *, (xmax = 0) AS is_insert`,
    [subscriptionId, subscriberId, skill.id],
  );
  if (rows[0] && (rows[0] as Record<string, unknown>).is_insert) {
    await pool.query(
      `UPDATE user_custom_skills
       SET stat_subscriber_count = stat_subscriber_count + 1,
           updated_at = NOW()
       WHERE id = $1`,
      [skill.id],
    );
  }
  return rows[0] as UserSkillSubscription;
}

export async function unsubscribeFromSkill(
  subscriptionId: string,
  subscriberId: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    'DELETE FROM user_skill_subscriptions WHERE id = $1 AND subscriber_id = $2 RETURNING skill_id',
    [subscriptionId, subscriberId],
  );
  if (rows.length > 0) {
    await pool.query(
      `UPDATE user_custom_skills SET stat_subscriber_count = GREATEST(0, stat_subscriber_count - 1), updated_at = NOW() WHERE id = $1`,
      [(rows[0] as { skill_id: string }).skill_id],
    );
    return true;
  }
  return false;
}

export async function toggleSubscription(
  subscriptionId: string,
  subscriberId: string,
): Promise<boolean | null> {
  const { rows } = await pool.query(
    `UPDATE user_skill_subscriptions SET enabled = NOT enabled
     WHERE id = $1 AND subscriber_id = $2
     RETURNING enabled`,
    [subscriptionId, subscriberId],
  );
  if (rows.length === 0) return null;
  return (rows[0] as { enabled: boolean }).enabled;
}

export async function getSubscribedSkills(subscriberId: string): Promise<
  (UserCustomSkill & {
    subscription_id: string;
    subscription_enabled: boolean;
    has_direct_source: boolean;
    source_bundles: Array<{ id: string; name: string }>;
  })[]
> {
  const { rows } = await pool.query(
    `SELECT ${USER_CUSTOM_SKILL_SELECT_COLUMNS},
            sub.id as subscription_id,
            sub.enabled as subscription_enabled,
            sub.has_direct_source,
            COALESCE(
              (
                SELECT jsonb_agg(
                  jsonb_build_object('id', b.id, 'name', b.name)
                  ORDER BY src.created_at ASC
                )
                FROM user_skill_subscription_bundle_sources src
                JOIN skill_bundles b ON b.id = src.bundle_id
                WHERE src.subscription_id = sub.id
              ),
              '[]'::jsonb
            ) AS source_bundles
     FROM user_skill_subscriptions sub
     JOIN user_custom_skills s ON s.id = sub.skill_id
     LEFT JOIN user_custom_skill_contents sc ON sc.skill_id = s.id
     WHERE sub.subscriber_id = $1
       AND sub.status = 'active'
       AND (sub.expires_at IS NULL OR sub.expires_at > NOW())
       AND s.deleted_at IS NULL
       AND s.visibility IN ('link_shared', 'shared')`,
    [subscriberId],
  );
  return rows as (UserCustomSkill & {
    subscription_id: string;
    subscription_enabled: boolean;
    has_direct_source: boolean;
    source_bundles: Array<{ id: string; name: string }>;
  })[];
}

/** 获取订阅某个 skill 的所有用户 ID */
export async function getSubscriberIds(skillId: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT subscriber_id
     FROM user_skill_subscriptions
     WHERE skill_id = $1
       AND enabled = true
       AND status = 'active'
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [skillId],
  );
  return (rows as { subscriber_id: string }[]).map((r) => r.subscriber_id);
}

export interface SubscribeToSkillPaidInput {
  subscriberId: string;
  skillId: string;
  tierKey: string;
  pricePoints: number;
  durationDays: number | null;
}

export interface SubscribeToSkillPaidResult {
  subscription: UserSkillSubscription;
  chargedPoints: number;
  platformCutPoints: number;
  creatorNetPoints: number;
}

export async function subscribeToSkillPaid(
  input: SubscribeToSkillPaidInput,
): Promise<SubscribeToSkillPaidResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: skillRows } = await client.query(
      `SELECT ${USER_CUSTOM_SKILL_SELECT_COLUMNS}
       FROM user_custom_skills s
       LEFT JOIN user_custom_skill_contents sc ON sc.skill_id = s.id
       WHERE s.id = $1 AND s.deleted_at IS NULL AND s.visibility IN ('link_shared', 'shared')
       FOR UPDATE OF s`,
      [input.skillId],
    );
    const skill = skillRows[0] as UserCustomSkill | undefined;
    if (!skill) throw new Error('Skill 不存在或未公开');
    if (skill.user_id === input.subscriberId)
      throw new Error('不能订阅自己的 Skill');

    let chargedPoints = 0;
    let platformCutPoints = 0;
    let creatorNetPoints = 0;

    if (input.pricePoints > 0) {
      const subscriber = await getUserByIdUsing(client, input.subscriberId, {
        forUpdate: true,
      });
      if (!subscriber) throw new Error('账号不存在');

      // 可用积分 = (purchased + bonus) - reserved
      const availablePoints = calculateAvailableSpendablePoints(subscriber);
      if (availablePoints < input.pricePoints)
        throw new Error('积分不足，请先充值');

      chargedPoints = input.pricePoints;
      platformCutPoints = Math.round(
        (chargedPoints * PLATFORM_CUT_PERCENT) / 100,
      );
      creatorNetPoints = chargedPoints - platformCutPoints;

      // bonus → purchased 优先级扣减
      const deduction = await deductPoints(client, subscriber, chargedPoints);

      for (const bd of deduction.batchDeductions) {
        await insertWalletTransaction(client, {
          userId: input.subscriberId,
          kind: 'skill_subscription',
          amountPoints: -bd.points,
          pointSource: 'bonus',
          pointBatchId: bd.batchId,
          note: `订阅技能: ${skill.skill_name}（赠送积分批次）`,
          metadata: { skill_id: input.skillId, tier_key: input.tierKey },
        });
      }
      if (deduction.purchasedDeducted > 0) {
        await insertWalletTransaction(client, {
          userId: input.subscriberId,
          kind: 'skill_subscription',
          amountPoints: -deduction.purchasedDeducted,
          pointSource: deduction.pointSource ?? 'purchased',
          note: `订阅技能: ${skill.skill_name}`,
          metadata: {
            skill_id: input.skillId,
            tier_key: input.tierKey,
            bonusDeducted: deduction.bonusDeducted,
            purchasedDeducted: deduction.purchasedDeducted,
          },
        });
      }

      // 创作者收益进 earned_points
      await client.query(
        `UPDATE users SET earned_points = earned_points + $1 WHERE id = $2`,
        [creatorNetPoints, skill.user_id],
      );
      await insertWalletTransaction(client, {
        userId: skill.user_id,
        kind: 'creator_revenue',
        amountPoints: creatorNetPoints,
        pointSource: 'earned',
        note: `技能订阅收入: ${skill.skill_name}`,
        metadata: {
          skill_id: input.skillId,
          subscriber_id: input.subscriberId,
          tier_key: input.tierKey,
          gross_points: chargedPoints,
          platform_cut_points: platformCutPoints,
        },
      });

      const yearMonth = new Date().toISOString().slice(0, 7);
      await client.query(
        `INSERT INTO creator_earnings_monthly
           (creator_id, year_month,
            gross_points, platform_cut_points, net_points,
            updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (creator_id, year_month) DO UPDATE SET
           gross_points = creator_earnings_monthly.gross_points + EXCLUDED.gross_points,
           platform_cut_points = creator_earnings_monthly.platform_cut_points + EXCLUDED.platform_cut_points,
           net_points = creator_earnings_monthly.net_points + EXCLUDED.net_points,
           updated_at = NOW()`,
        [
          skill.user_id,
          yearMonth,
          chargedPoints,
          platformCutPoints,
          creatorNetPoints,
        ],
      );
    }

    const now = new Date();
    const expiresAt = input.durationDays
      ? new Date(now.getTime() + input.durationDays * 86400_000).toISOString()
      : null;
    const subId = `sksub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const { rows: subRows } = await client.query(
      `INSERT INTO user_skill_subscriptions
         (id, subscriber_id, skill_id, tier_key, status, started_at, expires_at)
       VALUES ($1, $2, $3, $4, 'active', $5, $6)
       ON CONFLICT (subscriber_id, skill_id) DO UPDATE SET
         tier_key = EXCLUDED.tier_key, status = 'active',
         started_at = EXCLUDED.started_at, expires_at = EXCLUDED.expires_at,
         enabled = true, has_direct_source = true
       RETURNING *, (xmax = 0) AS is_insert`,
      [
        subId,
        input.subscriberId,
        input.skillId,
        input.tierKey,
        now.toISOString(),
        expiresAt,
      ],
    );

    if (subRows[0] && (subRows[0] as Record<string, unknown>).is_insert) {
      await client.query(
        `UPDATE user_custom_skills SET stat_subscriber_count = stat_subscriber_count + 1, updated_at = NOW() WHERE id = $1`,
        [input.skillId],
      );
    }

    await client.query('COMMIT');
    return {
      subscription: subRows[0] as UserSkillSubscription,
      chargedPoints,
      platformCutPoints,
      creatorNetPoints,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface SubscribeToCreatorBundleInput {
  subscriberId: string;
  creatorId: string;
  tierKey: string;
  pricePoints: number;
  durationDays: number | null;
}

export async function subscribeToCreatorBundle(
  input: SubscribeToCreatorBundleInput,
): Promise<{ chargedPoints: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: creatorRows } = await client.query(
      `SELECT 1 FROM users WHERE id = $1`,
      [input.creatorId],
    );
    if (!creatorRows[0]) throw new Error('创作者不存在');
    if (input.creatorId === input.subscriberId) throw new Error('不能订阅自己');

    let chargedPoints = 0;
    if (input.pricePoints > 0) {
      const subscriber = await getUserByIdUsing(client, input.subscriberId, {
        forUpdate: true,
      });
      if (!subscriber) throw new Error('账号不存在');

      const availablePoints = calculateAvailableSpendablePoints(subscriber);
      if (availablePoints < input.pricePoints)
        throw new Error('积分不足，请先充值');

      chargedPoints = input.pricePoints;
      const platformCutPoints = Math.round(
        (chargedPoints * PLATFORM_CUT_PERCENT) / 100,
      );
      const creatorNetPoints = chargedPoints - platformCutPoints;

      const deduction = await deductPoints(client, subscriber, chargedPoints);

      for (const bd of deduction.batchDeductions) {
        await insertWalletTransaction(client, {
          userId: input.subscriberId,
          kind: 'bundle_subscription',
          amountPoints: -bd.points,
          pointSource: 'bonus',
          pointBatchId: bd.batchId,
          note: `订阅创作者整包（赠送积分批次）`,
          metadata: { creator_id: input.creatorId, tier_key: input.tierKey },
        });
      }
      if (deduction.purchasedDeducted > 0) {
        await insertWalletTransaction(client, {
          userId: input.subscriberId,
          kind: 'bundle_subscription',
          amountPoints: -deduction.purchasedDeducted,
          pointSource: deduction.pointSource ?? 'purchased',
          note: `订阅创作者整包`,
          metadata: {
            creator_id: input.creatorId,
            tier_key: input.tierKey,
            bonusDeducted: deduction.bonusDeducted,
            purchasedDeducted: deduction.purchasedDeducted,
          },
        });
      }

      await client.query(
        `UPDATE users SET earned_points = earned_points + $1 WHERE id = $2`,
        [creatorNetPoints, input.creatorId],
      );
      await insertWalletTransaction(client, {
        userId: input.creatorId,
        kind: 'creator_revenue',
        amountPoints: creatorNetPoints,
        pointSource: 'earned',
        note: `整包订阅收入`,
        metadata: {
          subscriber_id: input.subscriberId,
          tier_key: input.tierKey,
          gross_points: chargedPoints,
          platform_cut_points: platformCutPoints,
        },
      });

      const yearMonth = new Date().toISOString().slice(0, 7);
      await client.query(
        `INSERT INTO creator_earnings_monthly
           (creator_id, year_month,
            gross_points, platform_cut_points, net_points,
            updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (creator_id, year_month) DO UPDATE SET
           gross_points = creator_earnings_monthly.gross_points + EXCLUDED.gross_points,
           platform_cut_points = creator_earnings_monthly.platform_cut_points + EXCLUDED.platform_cut_points,
           net_points = creator_earnings_monthly.net_points + EXCLUDED.net_points,
           updated_at = NOW()`,
        [
          input.creatorId,
          yearMonth,
          chargedPoints,
          platformCutPoints,
          creatorNetPoints,
        ],
      );
    }

    const now = new Date();
    const expiresAt = input.durationDays
      ? new Date(now.getTime() + input.durationDays * 86400_000).toISOString()
      : null;
    const id = `bsub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    await client.query(
      `INSERT INTO creator_bundle_subscriptions
         (id, subscriber_id, creator_id, tier_key, status, started_at, expires_at)
       VALUES ($1, $2, $3, $4, 'active', $5, $6)
       ON CONFLICT (subscriber_id, creator_id) DO UPDATE SET
         tier_key = EXCLUDED.tier_key, status = 'active',
         started_at = EXCLUDED.started_at, expires_at = EXCLUDED.expires_at`,
      [
        id,
        input.subscriberId,
        input.creatorId,
        input.tierKey,
        now.toISOString(),
        expiresAt,
      ],
    );

    await client.query('COMMIT');
    return { chargedPoints };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// =====================
// --- Skill Bundles ---
// =====================

/** 把 DB 原始行（skill_ids 为 text[] / JSON 字符串或数组）规范化为 SkillBundle */
function rowToSkillBundle(row: Record<string, unknown>): SkillBundle {
  const raw = row.skill_ids;
  const skillIds = Array.isArray(raw)
    ? (raw as unknown[]).map((value) => String(value))
    : typeof raw === 'string'
      ? (JSON.parse(raw) as string[])
      : [];
  return { ...(row as unknown as SkillBundle), skill_ids: skillIds };
}

async function getSkillBundleById(
  id: string,
  userId?: string,
): Promise<SkillBundle | undefined> {
  const params: unknown[] = [id];
  let whereClause = `WHERE b.id = $1 AND b.deleted_at IS NULL`;
  if (userId) {
    params.push(userId);
    whereClause += ` AND b.user_id = $2`;
  }
  const { rows } = await pool.query(
    `SELECT ${SKILL_BUNDLE_SELECT_COLUMNS}
     FROM skill_bundles b
     ${whereClause}`,
    params,
  );
  return rows[0]
    ? rowToSkillBundle(rows[0] as Record<string, unknown>)
    : undefined;
}

async function validateBundleSkillOwnershipUsing(
  client: pg.PoolClient,
  userId: string,
  skillIds: string[],
): Promise<string[]> {
  const unique = Array.from(new Set(skillIds));
  if (unique.length === 0) throw new Error('bundle 至少包含 1 个技能');
  const { rows } = await client.query<{ cnt: string }>(
    `SELECT COUNT(*) as cnt FROM user_custom_skills
     WHERE id = ANY($1) AND user_id = $2 AND deleted_at IS NULL`,
    [unique, userId],
  );
  if (Number(rows[0].cnt) !== unique.length) {
    throw new Error('bundle 包含非法 skill');
  }
  return unique;
}

async function replaceSkillBundleItemsUsing(
  client: pg.PoolClient,
  bundleId: string,
  skillIds: string[],
): Promise<void> {
  await client.query(`DELETE FROM skill_bundle_items WHERE bundle_id = $1`, [
    bundleId,
  ]);
  await client.query(
    `INSERT INTO skill_bundle_items (bundle_id, skill_id, sort_order)
     SELECT $1, items.skill_id, (items.ordinality - 1)::int
     FROM UNNEST($2::text[]) WITH ORDINALITY AS items(skill_id, ordinality)`,
    [bundleId, skillIds],
  );
}

export async function createSkillBundle(
  id: string,
  userId: string,
  name: string,
  description: string,
  skillIds: string[],
): Promise<SkillBundle> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const unique = await validateBundleSkillOwnershipUsing(
      client,
      userId,
      skillIds,
    );
    await client.query(
      `INSERT INTO skill_bundles (id, user_id, name, description)
       VALUES ($1, $2, $3, $4)`,
      [id, userId, name, description],
    );
    await replaceSkillBundleItemsUsing(client, id, unique);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return (await getSkillBundleById(id, userId)) as SkillBundle;
}

export async function listUserBundles(userId: string): Promise<SkillBundle[]> {
  const { rows } = await pool.query(
    `SELECT ${SKILL_BUNDLE_SELECT_COLUMNS}
     FROM skill_bundles b
     WHERE user_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [userId],
  );
  return (rows as Record<string, unknown>[]).map(rowToSkillBundle);
}

export async function updateSkillBundle(
  id: string,
  userId: string,
  patch: { name?: string; description?: string; skill_ids?: string[] },
): Promise<SkillBundle | undefined> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (patch.name !== undefined) {
    fields.push(`name = $${idx++}`);
    values.push(patch.name);
  }
  if (patch.description !== undefined) {
    fields.push(`description = $${idx++}`);
    values.push(patch.description);
  }
  if (fields.length === 0 && patch.skill_ids === undefined) {
    return getSkillBundleById(id, userId);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let exists = false;
    if (fields.length > 0) {
      fields.push(`updated_at = NOW()`);
      values.push(id, userId);
      const result = await client.query(
        `UPDATE skill_bundles SET ${fields.join(', ')}
         WHERE id = $${idx++} AND user_id = $${idx} AND deleted_at IS NULL`,
        values,
      );
      exists = (result.rowCount ?? 0) > 0;
    } else {
      const { rowCount } = await client.query(
        `SELECT 1 FROM skill_bundles
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [id, userId],
      );
      exists = (rowCount ?? 0) > 0;
    }
    if (!exists) {
      await client.query('ROLLBACK');
      return undefined;
    }
    if (patch.skill_ids !== undefined) {
      const unique = await validateBundleSkillOwnershipUsing(
        client,
        userId,
        patch.skill_ids,
      );
      await replaceSkillBundleItemsUsing(client, id, unique);
      if (fields.length === 0) {
        await client.query(
          `UPDATE skill_bundles
           SET updated_at = NOW()
           WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [id, userId],
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getSkillBundleById(id, userId);
}

export async function deleteSkillBundle(
  id: string,
  userId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE skill_bundles SET deleted_at = NOW(), bundle_token = NULL, visibility = 'private'
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function shareSkillBundle(
  id: string,
  userId: string,
  token: string,
): Promise<SkillBundle | undefined> {
  const { rowCount } = await pool.query(
    `UPDATE skill_bundles
     SET visibility = CASE WHEN visibility = 'shared' THEN 'shared' ELSE 'link_shared' END,
         bundle_token = COALESCE(bundle_token, $3),
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId, token],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getSkillBundleById(id, userId);
}

export async function unshareSkillBundle(
  id: string,
  userId: string,
): Promise<SkillBundle | undefined> {
  const { rowCount } = await pool.query(
    `UPDATE skill_bundles
     SET visibility = CASE WHEN visibility = 'shared' THEN 'shared' ELSE 'private' END,
         bundle_token = CASE WHEN visibility = 'shared' THEN bundle_token ELSE NULL END,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getSkillBundleById(id, userId);
}

export async function publishSkillBundle(
  id: string,
  userId: string,
  token: string,
): Promise<SkillBundle | undefined> {
  const { rowCount } = await pool.query(
    `UPDATE skill_bundles
     SET visibility = 'shared',
         bundle_token = COALESCE(bundle_token, $3),
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId, token],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getSkillBundleById(id, userId);
}

export async function unpublishSkillBundle(
  id: string,
  userId: string,
): Promise<SkillBundle | undefined> {
  const { rowCount } = await pool.query(
    `UPDATE skill_bundles
     SET visibility = CASE WHEN bundle_token IS NULL THEN 'private' ELSE 'link_shared' END,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getSkillBundleById(id, userId);
}

export interface BundleByTokenResult {
  bundle: SkillBundle;
  skills: Array<{
    id: string;
    skill_name: string;
    description: string;
    category: string;
    content_length: number;
  }>;
}

export async function getBundleByToken(
  token: string,
): Promise<BundleByTokenResult | undefined> {
  const { rows } = await pool.query(
    `SELECT ${SKILL_BUNDLE_SELECT_COLUMNS}
     FROM skill_bundles b
     WHERE b.bundle_token = $1 AND b.deleted_at IS NULL AND b.visibility IN ('link_shared', 'shared')`,
    [token],
  );
  if (rows.length === 0) return undefined;
  const row = rows[0] as Record<string, unknown>;
  const bundle = rowToSkillBundle(row);
  if (bundle.skill_ids.length === 0) {
    return {
      bundle,
      skills: [],
    };
  }
  const { rows: skillRows } = await pool.query(
    `SELECT s.id, s.skill_name, s.description, s.category, COALESCE(sc.content, '') AS content
     FROM user_custom_skills s
     LEFT JOIN user_custom_skill_contents sc ON sc.skill_id = s.id
     WHERE s.id = ANY($1) AND s.deleted_at IS NULL AND s.visibility IN ('link_shared', 'shared')`,
    [bundle.skill_ids],
  );
  // 保留 bundle.skill_ids 原始顺序
  const byId = new Map(
    (skillRows as Array<Record<string, unknown>>).map((r) => [
      r.id as string,
      r,
    ]),
  );
  const skills = bundle.skill_ids
    .map((sid) => byId.get(sid))
    .filter((x): x is Record<string, unknown> => Boolean(x))
    .map((r) => ({
      id: r.id as string,
      skill_name: r.skill_name as string,
      description: r.description as string,
      category: r.category as string,
      content_length: (r.content as string).length,
    }));
  return {
    bundle,
    skills,
  };
}

export interface SubscribeToBundleResult {
  subscribedCount: number;
  skippedCount: number;
  subscriptionIds: string[];
}

export async function subscribeToBundle(
  subscriberId: string,
  token: string,
): Promise<SubscribeToBundleResult | null> {
  const info = await getBundleByToken(token);
  if (!info) return null;
  if (info.bundle.user_id === subscriberId) return null; // 非自订

  const skillIdsValid = info.skills.map((s) => s.id);
  // getBundleByToken 内部已过滤失效（deleted_at / visibility）。
  // bundle.skill_ids 原始长度 - 有效长度 = 静默跳过的失效条数
  let skippedCount = info.bundle.skill_ids.length - skillIdsValid.length;
  let subscribedCount = 0;
  const subscriptionIds: string[] = [];
  const insertedSkillIds = new Set<string>();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const skillId of skillIdsValid) {
      const subId = crypto.randomUUID();
      const { rows, rowCount } = await client.query(
        `INSERT INTO user_skill_subscriptions
           (id, subscriber_id, skill_id, has_direct_source)
         VALUES ($1, $2, $3, false)
         ON CONFLICT (subscriber_id, skill_id) DO NOTHING
         RETURNING id`,
        [subId, subscriberId, skillId],
      );
      const subscriptionId =
        rowCount && rowCount > 0
          ? (rows[0] as { id: string }).id
          : await getActiveUserSkillSubscriptionIdUsing(
              client,
              subscriberId,
              skillId,
            );
      if (!subscriptionId) {
        skippedCount++;
        continue;
      }
      await client.query(
        `INSERT INTO user_skill_subscription_bundle_sources
           (subscription_id, bundle_id)
         VALUES ($1, $2)
         ON CONFLICT (subscription_id, bundle_id) DO NOTHING`,
        [subscriptionId, info.bundle.id],
      );
      if (rowCount && rowCount > 0) {
        subscribedCount++;
        subscriptionIds.push(subscriptionId);
        insertedSkillIds.add(skillId);
      } else {
        skippedCount++;
      }
    }
    if (insertedSkillIds.size > 0) {
      await client.query(
        `UPDATE user_custom_skills
         SET stat_subscriber_count = stat_subscriber_count + 1,
             updated_at = NOW()
         WHERE id = ANY($1)`,
        [Array.from(insertedSkillIds)],
      );
    }
    await client.query('COMMIT');
    return { subscribedCount, skippedCount, subscriptionIds };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function unsubscribeFromBundle(
  bundleId: string,
  subscriberId: string,
): Promise<number> {
  const { rows } = await pool.query(
    `WITH affected AS (
       SELECT sub.id, sub.skill_id
       FROM user_skill_subscriptions sub
       JOIN user_skill_subscription_bundle_sources src
         ON src.subscription_id = sub.id
       WHERE sub.subscriber_id = $1 AND src.bundle_id = $2
     ),
     deleted_sources AS (
       DELETE FROM user_skill_subscription_bundle_sources src
       USING affected a
       WHERE src.subscription_id = a.id AND src.bundle_id = $2
       RETURNING src.subscription_id
     ),
     removable AS (
       SELECT sub.id, sub.skill_id
       FROM user_skill_subscriptions sub
       JOIN affected a ON a.id = sub.id
       WHERE sub.has_direct_source = false
         AND NOT EXISTS (
           SELECT 1
           FROM user_skill_subscription_bundle_sources src
           WHERE src.subscription_id = sub.id
         )
     ),
     deleted_subscriptions AS (
       DELETE FROM user_skill_subscriptions sub
       USING removable r
       WHERE sub.id = r.id
       RETURNING sub.skill_id
     ),
     decrements AS (
       SELECT skill_id, COUNT(*)::int AS count
       FROM deleted_subscriptions
       GROUP BY skill_id
     ),
     updated AS (
       UPDATE user_custom_skills s
       SET stat_subscriber_count = GREATEST(0, s.stat_subscriber_count - d.count),
           updated_at = NOW()
       FROM decrements d
       WHERE s.id = d.skill_id
       RETURNING s.id
     )
     SELECT
       (SELECT COUNT(*)::int FROM deleted_sources) AS deleted_source_count,
       COALESCE((SELECT SUM(count)::int FROM decrements), 0) AS deleted_count`,
    [subscriberId, bundleId],
  );
  return Number(
    (rows[0] as { deleted_source_count: number | string }).deleted_source_count,
  );
}

/**
 * 获取用户的有效 skill 列表（自有 + 直接订阅 + 整包订阅），用于 IPC 同步。
 */
export async function getEffectiveUserSkills(
  userId: string,
): Promise<EffectiveUserSkill[]> {
  const { rows } = await pool.query(
    `SELECT s.dir_name as dir, s.skill_name as name, s.description, s.trigger_hint as trigger, COALESCE(sc.content, '') AS content,
            COALESCE(category, '通用') as category, category_normalized,
            match_keywords, match_patterns, example_queries, priority, usage_mode,
            'self' as source
     FROM user_custom_skills s
     LEFT JOIN user_custom_skill_contents sc ON sc.skill_id = s.id
     WHERE s.user_id = $1 AND s.enabled = true AND s.deleted_at IS NULL
     UNION ALL
    SELECT s.dir_name as dir, s.skill_name as name, s.description, s.trigger_hint as trigger, COALESCE(sc.content, '') AS content,
            COALESCE(s.category, '通用') as category, s.category_normalized,
            s.match_keywords, s.match_patterns, s.example_queries, s.priority, s.usage_mode,
            'subscribed' as source
     FROM user_skill_subscriptions sub
     JOIN user_custom_skills s ON s.id = sub.skill_id
     LEFT JOIN user_custom_skill_contents sc ON sc.skill_id = s.id
     WHERE sub.subscriber_id = $1 AND sub.enabled = true AND sub.status = 'active'
       AND (sub.expires_at IS NULL OR sub.expires_at > NOW())
       AND s.deleted_at IS NULL AND s.visibility IN ('link_shared', 'shared')
     UNION ALL
    SELECT s.dir_name as dir, s.skill_name as name, s.description, s.trigger_hint as trigger, COALESCE(sc.content, '') AS content,
            COALESCE(s.category, '通用') as category, s.category_normalized,
            s.match_keywords, s.match_patterns, s.example_queries, s.priority, s.usage_mode,
            'subscribed' as source
     FROM creator_bundle_subscriptions bs
     JOIN user_custom_skills s ON s.user_id = bs.creator_id
     LEFT JOIN user_custom_skill_contents sc ON sc.skill_id = s.id
     WHERE bs.subscriber_id = $1 AND bs.status = 'active'
       AND (bs.expires_at IS NULL OR bs.expires_at > NOW())
       AND s.deleted_at IS NULL AND s.visibility IN ('link_shared', 'shared')
       AND NOT EXISTS (
         SELECT 1 FROM user_skill_subscriptions sub2
         WHERE sub2.subscriber_id = $1 AND sub2.skill_id = s.id
       )`,
    [userId],
  );
  return rows as EffectiveUserSkill[];
}

// =====================
// --- Skill market queries ---

export interface MarketSkillListRow {
  id: string;
  skill_name: string;
  description: string;
  category: string;
  price_tiers: UserCustomSkill['price_tiers'];
  stat_subscriber_count: number;
  share_token: string | null;
}

export async function listMarketSkills(opts: {
  category?: string;
  limit?: number;
  offset?: number;
}): Promise<MarketSkillListRow[]> {
  const conditions = ['s.deleted_at IS NULL', "s.visibility = 'shared'"];
  const params: unknown[] = [];
  if (opts.category) {
    params.push(opts.category);
    conditions.push(`s.category = $${params.length}`);
  }
  const lim = Math.min(opts.limit ?? 50, 100);
  const off = opts.offset ?? 0;
  params.push(lim, off);
  const { rows } = await pool.query(
    `SELECT s.id, s.skill_name, s.description, s.category, s.price_tiers,
            s.stat_subscriber_count,
            s.stat_view_count, s.share_token
     FROM user_custom_skills s
     WHERE ${conditions.join(' AND ')}
     ORDER BY s.stat_subscriber_count DESC, s.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows as MarketSkillListRow[];
}

export interface MarketBundleListRow {
  id: string;
  name: string;
  description: string;
  skill_count: number;
  bundle_token: string;
}

export async function listMarketBundles(opts: {
  category?: string;
  limit?: number;
  offset?: number;
}): Promise<MarketBundleListRow[]> {
  const conditions = [
    'b.deleted_at IS NULL',
    "b.visibility = 'shared'",
    'b.bundle_token IS NOT NULL',
  ];
  const params: unknown[] = [];

  if (opts.category) {
    params.push(opts.category);
    conditions.push(`
      EXISTS (
        SELECT 1
        FROM skill_bundle_items sbi2
        JOIN user_custom_skills s2 ON s2.id = sbi2.skill_id
        WHERE sbi2.bundle_id = b.id
          AND s2.deleted_at IS NULL
          AND s2.visibility IN ('link_shared', 'shared')
          AND s2.category = $${params.length}
      )
    `);
  }

  const lim = Math.min(opts.limit ?? 20, 50);
  const off = opts.offset ?? 0;
  params.push(lim, off);

  const { rows } = await pool.query(
    `SELECT
        b.id,
        b.name,
        b.description,
        b.bundle_token,
        COUNT(s.id)::int AS skill_count
     FROM skill_bundles b
     LEFT JOIN skill_bundle_items sbi ON sbi.bundle_id = b.id
     LEFT JOIN user_custom_skills s
       ON s.id = sbi.skill_id
      AND s.deleted_at IS NULL
      AND s.visibility IN ('link_shared', 'shared')
     WHERE ${conditions.join(' AND ')}
     GROUP BY b.id, b.name, b.description, b.bundle_token, b.created_at
     HAVING COUNT(s.id) > 0
     ORDER BY COUNT(s.id) DESC, b.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return rows as MarketBundleListRow[];
}

export async function getCreatorBundleConfig(
  creatorId: string,
): Promise<{ bundle_tiers: unknown[] } | undefined> {
  const { rows } = await pool.query(
    'SELECT * FROM creator_bundle_config WHERE creator_id = $1',
    [creatorId],
  );
  return rows[0] as { bundle_tiers: unknown[] } | undefined;
}

export async function upsertCreatorBundleConfig(
  creatorId: string,
  bundleTiers: unknown[],
): Promise<void> {
  await pool.query(
    `INSERT INTO creator_bundle_config (creator_id, bundle_tiers, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (creator_id) DO UPDATE SET bundle_tiers = $2, updated_at = NOW()`,
    [creatorId, JSON.stringify(bundleTiers)],
  );
}

export async function listCreatorSharedSkills(
  creatorId: string,
): Promise<unknown[]> {
  const { rows } = await pool.query(
    `SELECT id, skill_name, description, category, price_tiers
     FROM user_custom_skills
     WHERE user_id = $1 AND visibility = 'shared' AND deleted_at IS NULL`,
    [creatorId],
  );
  return rows;
}

// --- User role accessors ---
// =====================

export async function updateUserRole(
  userId: string,
  role: UserRole,
): Promise<void> {
  await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, userId]);
}

/** 消费者申请成为创作者：consumer → both（保留消费者能力），creator → creator（幂等） */
export async function promoteUserToCreator(userId: string): Promise<UserRole> {
  const { rows } = await pool.query(
    `UPDATE users
       SET role = CASE role
         WHEN 'consumer' THEN 'both'
         WHEN 'admin' THEN 'admin'
         ELSE role
       END
     WHERE id = $1
     RETURNING role`,
    [userId],
  );
  return (rows[0]?.role ?? 'consumer') as UserRole;
}

// =====================
// --- Creator earnings accessors ---
// =====================

export async function getCreatorEarnings(
  creatorId: string,
  limit = 12,
): Promise<CreatorEarningsMonthly[]> {
  const { rows } = await pool.query(
    `SELECT * FROM creator_earnings_monthly
     WHERE creator_id = $1
     ORDER BY year_month DESC
     LIMIT $2`,
    [creatorId, limit],
  );
  return rows as CreatorEarningsMonthly[];
}

// =====================
// --- System config accessors ---
// =====================

export async function getSystemSecret(
  key: string,
): Promise<SystemSecretRow | undefined> {
  const { rows } = await pool.query(
    'SELECT * FROM system_secrets WHERE key = $1',
    [key],
  );
  return rows[0] as SystemSecretRow | undefined;
}

export async function upsertSystemSecret(input: {
  key: string;
  secretValue: string;
  updatedBy?: string | null;
}): Promise<SystemSecretRow> {
  const { rows } = await pool.query(
    `INSERT INTO system_secrets
       (key, secret_value, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET
       secret_value = EXCLUDED.secret_value,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING *`,
    [input.key, input.secretValue, input.updatedBy ?? null],
  );
  return rows[0] as SystemSecretRow;
}

function mapOfficialModelRow(row: unknown): OfficialModelConfig {
  const record = row as OfficialModelConfig;
  return {
    ...record,
    extra_json: toJsonObject(record.extra_json),
  };
}

function mapUserModelRow(row: unknown): UserModelConfig {
  const record = row as UserModelConfig;
  return {
    ...record,
    extra_json: toJsonObject(record.extra_json),
  };
}

export async function listOfficialModelConfigs(): Promise<
  OfficialModelConfig[]
> {
  const { rows } = await pool.query(
    `SELECT *
     FROM official_model_configs
     ORDER BY enabled DESC, priority ASC, created_at ASC`,
  );
  return rows.map(mapOfficialModelRow);
}

export async function getOfficialModelConfig(
  id: string,
): Promise<OfficialModelConfig | undefined> {
  const { rows } = await pool.query(
    'SELECT * FROM official_model_configs WHERE id = $1',
    [id],
  );
  return rows[0] ? mapOfficialModelRow(rows[0]) : undefined;
}

export async function createOfficialModelConfig(input: {
  id: string;
  modelKey: string;
  protocol: ModelProviderType;
  displayName: string;
  enabled?: boolean;
  priority?: number;
  baseUrl?: string | null;
  modelName: string;
  apiKeySecretKey?: string | null;
  inputTokenPricePerMillionPoints?: number;
  outputTokenPricePerMillionPoints?: number;
  extraJson?: Record<string, unknown> | null;
}): Promise<OfficialModelConfig> {
  const { rows } = await pool.query(
    `INSERT INTO official_model_configs
       (
         id, model_key, protocol, display_name, enabled, priority,
         base_url, model_name, api_key_secret_key,
         input_token_price_per_million_points,
         output_token_price_per_million_points,
         extra_json, created_at, updated_at
       )
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
     RETURNING *`,
    [
      input.id,
      input.modelKey,
      input.protocol,
      input.displayName,
      input.enabled ?? true,
      input.priority ?? 0,
      input.baseUrl ?? null,
      input.modelName,
      input.apiKeySecretKey ?? null,
      input.inputTokenPricePerMillionPoints ?? 0,
      input.outputTokenPricePerMillionPoints ?? 0,
      JSON.stringify(input.extraJson ?? {}),
    ],
  );
  return mapOfficialModelRow(rows[0]);
}

export async function updateOfficialModelConfig(input: {
  id: string;
  modelKey: string;
  protocol: ModelProviderType;
  displayName: string;
  enabled: boolean;
  priority: number;
  baseUrl?: string | null;
  modelName: string;
  apiKeySecretKey?: string | null;
  inputTokenPricePerMillionPoints: number;
  outputTokenPricePerMillionPoints: number;
  extraJson?: Record<string, unknown> | null;
}): Promise<OfficialModelConfig | undefined> {
  const { rows } = await pool.query(
    `UPDATE official_model_configs
     SET model_key = $2,
         protocol = $3,
         display_name = $4,
         enabled = $5,
         priority = $6,
         base_url = $7,
         model_name = $8,
         api_key_secret_key = $9,
         input_token_price_per_million_points = $10,
         output_token_price_per_million_points = $11,
         extra_json = $12,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      input.id,
      input.modelKey,
      input.protocol,
      input.displayName,
      input.enabled,
      input.priority,
      input.baseUrl ?? null,
      input.modelName,
      input.apiKeySecretKey ?? null,
      input.inputTokenPricePerMillionPoints,
      input.outputTokenPricePerMillionPoints,
      JSON.stringify(input.extraJson ?? {}),
    ],
  );
  return rows[0] ? mapOfficialModelRow(rows[0]) : undefined;
}

export async function deleteOfficialModelConfig(id: string): Promise<void> {
  await pool.query('DELETE FROM official_model_configs WHERE id = $1', [id]);
}

export async function getUserModelConfig(
  userId: string,
): Promise<UserModelConfig | undefined> {
  const { rows } = await pool.query(
    'SELECT * FROM user_model_configs WHERE user_id = $1',
    [userId],
  );
  return rows[0] ? mapUserModelRow(rows[0]) : undefined;
}

export async function upsertUserModelConfig(input: {
  userId: string;
  protocol: ModelProviderType;
  baseUrl?: string | null;
  modelName: string;
  apiKeySecretKey?: string | null;
  extraJson?: Record<string, unknown> | null;
}): Promise<UserModelConfig> {
  const { rows } = await pool.query(
    `INSERT INTO user_model_configs
       (user_id, protocol, base_url, model_name, api_key_secret_key,
        extra_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       protocol = EXCLUDED.protocol,
       base_url = EXCLUDED.base_url,
       model_name = EXCLUDED.model_name,
       api_key_secret_key = EXCLUDED.api_key_secret_key,
       extra_json = EXCLUDED.extra_json,
       updated_at = NOW()
     RETURNING *`,
    [
      input.userId,
      input.protocol,
      input.baseUrl ?? null,
      input.modelName,
      input.apiKeySecretKey ?? null,
      JSON.stringify(input.extraJson ?? {}),
    ],
  );
  return mapUserModelRow(rows[0]);
}

export async function getUserModelSelection(
  userId: string,
): Promise<UserModelSelection | undefined> {
  const { rows } = await pool.query(
    'SELECT * FROM user_model_selections WHERE user_id = $1',
    [userId],
  );
  return rows[0] as UserModelSelection | undefined;
}

export async function upsertUserModelSelection(input: {
  userId: string;
  source: UserModelSelection['source'];
  officialModelId?: string | null;
}): Promise<UserModelSelection> {
  const { rows } = await pool.query(
    `INSERT INTO user_model_selections
       (user_id, source, official_model_id, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       source = EXCLUDED.source,
       official_model_id = EXCLUDED.official_model_id,
       updated_at = NOW()
     RETURNING *`,
    [input.userId, input.source, input.officialModelId ?? null],
  );
  return rows[0] as UserModelSelection;
}

export async function createConfigAuditLog(input: {
  id: string;
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetKey: string;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  await pool.query(
    `INSERT INTO config_audit_logs
       (
         id, actor_user_id, action, target_type, target_key,
         before_json, after_json, created_at
       )
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [
      input.id,
      input.actorUserId ?? null,
      input.action,
      input.targetType,
      input.targetKey,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
    ],
  );
}

export async function listConfigAuditLogs(
  limit = 50,
): Promise<ConfigAuditLog[]> {
  const { rows } = await pool.query(
    `SELECT *
     FROM config_audit_logs
     ORDER BY created_at DESC
     LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return rows as ConfigAuditLog[];
}

// EOF — Persona 相关代码已删除
