import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段：0045-0047。
 */
export const sqlReviewFixMigrations: readonly DatabaseMigration[] = [
  {
    id: '0045_sql_review_indexes_and_bundle_stats',
    description: '补充 SQL review 后的查询索引和 Bundle 市场统计字段',
    async up(client) {
      await client.query(`
        ALTER TABLE skill_bundles
          ADD COLUMN IF NOT EXISTS stat_skill_count INTEGER NOT NULL DEFAULT 0
      `);
      await client.query(`
        WITH counts AS (
          SELECT
            b.id,
            COUNT(s.id)::int AS skill_count
          FROM skill_bundles b
          LEFT JOIN skill_bundle_items sbi ON sbi.bundle_id = b.id
          LEFT JOIN user_custom_skills s
            ON s.id = sbi.skill_id
           AND s.deleted_at IS NULL
           AND COALESCE(s.audit_metadata->>'source', '') <> 'simple_workflow_snapshot'
          GROUP BY b.id
        )
        UPDATE skill_bundles b
        SET stat_skill_count = counts.skill_count
        FROM counts
        WHERE b.id = counts.id
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_skill_bundles_market_listing
          ON skill_bundles(stat_skill_count DESC, created_at DESC)
          WHERE deleted_at IS NULL
            AND visibility = 'shared'
            AND bundle_token IS NOT NULL
            AND stat_skill_count > 0
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created_at
          ON wallet_transactions(created_at DESC)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_wallet_transactions_kind_created_at
          ON wallet_transactions(kind, created_at DESC)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_balance_grants_user_active_expiry_created
          ON balance_grants(user_id, expires_at, created_at)
          WHERE status = 'active' AND remaining_coins > 0
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_deleted_id
          ON chat_sessions(deleted_at, id)
          WHERE deleted_at IS NOT NULL
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_inactive_id
          ON chat_sessions(updated_at, id)
          WHERE deleted_at IS NULL
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_messages_account_deleted_timestamp
          ON messages(account_id, (deleted_at IS NOT NULL), timestamp DESC)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_messages_session_deleted_timestamp
          ON messages(session_id, (deleted_at IS NOT NULL), timestamp DESC)
          WHERE session_id IS NOT NULL
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_messages_user_deleted_timestamp
          ON messages(user_id, (deleted_at IS NOT NULL), timestamp DESC)
          WHERE user_id IS NOT NULL
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_users_created_at
          ON users(created_at DESC)
      `);
      await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_users_phone_trgm
          ON users USING GIN (phone gin_trgm_ops)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_users_id_trgm
          ON users USING GIN (id gin_trgm_ops)
      `);
    },
  },
  {
    id: '0046_skill_reactions_and_comments',
    description: '增加公开 Skill 赞踩与匿名评论审核表',
    async up(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS skill_reactions (
          skill_id TEXT NOT NULL REFERENCES user_custom_skills(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (skill_id, user_id)
        )
      `);
      await client.query(`
        ALTER TABLE skill_reactions
          DROP CONSTRAINT IF EXISTS chk_skill_reactions_kind_valid
      `);
      await client.query(`
        ALTER TABLE skill_reactions
          ADD CONSTRAINT chk_skill_reactions_kind_valid
          CHECK (kind IN ('like', 'dislike'))
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_skill_reactions_skill_kind
          ON skill_reactions(skill_id, kind)
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS skill_comments (
          id TEXT PRIMARY KEY,
          skill_id TEXT NOT NULL REFERENCES user_custom_skills(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          body TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          pinned BOOLEAN NOT NULL DEFAULT false,
          reviewed_by TEXT DEFAULT NULL,
          reviewed_at TIMESTAMPTZ DEFAULT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        ALTER TABLE skill_comments
          DROP CONSTRAINT IF EXISTS chk_skill_comments_status_valid
      `);
      await client.query(`
        ALTER TABLE skill_comments
          ADD CONSTRAINT chk_skill_comments_status_valid
          CHECK (status IN ('pending', 'approved', 'rejected'))
      `);
      await client.query(`
        ALTER TABLE skill_comments
          DROP CONSTRAINT IF EXISTS chk_skill_comments_body_length
      `);
      await client.query(`
        ALTER TABLE skill_comments
          ADD CONSTRAINT chk_skill_comments_body_length
          CHECK (char_length(body) BETWEEN 1 AND 500)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_skill_comments_public
          ON skill_comments(skill_id, pinned DESC, reviewed_at DESC, created_at DESC)
          WHERE status = 'approved'
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_skill_comments_admin_status
          ON skill_comments(status, created_at DESC)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_skill_comments_admin_skill
          ON skill_comments(skill_id, created_at DESC)
      `);
    },
  },
  {
    id: '0047_membership_default_pricing_snapshot',
    description: '同步会员套餐默认价格和额度配置',
    async up(client) {
      await client.query(`
        INSERT INTO membership_config (
          id, enabled, name, monthly_price_coins, display_price_coins,
          monthly_allowance_units, standard_price_per_million_units_coins,
          updated_at
        )
        VALUES
          (
            'fateclaw_clarity',
            true,
            'FateClaw Clarity',
            10,
            10,
            1000000,
            10,
            NOW()
          ),
          (
            'fateclaw_insight',
            true,
            'FateClaw Insight',
            30,
            30,
            3500000,
            10,
            NOW()
          ),
          (
            'fateclaw_deep',
            true,
            'FateClaw Deep',
            100,
            100,
            13000000,
            10,
            NOW()
          )
        ON CONFLICT (id) DO NOTHING
      `);
      await client.query(`
        WITH defaults (
          id,
          monthly_price_coins,
          display_price_coins,
          monthly_allowance_units,
          standard_price_per_million_units_coins
        ) AS (
          VALUES
            ('fateclaw_clarity', 10::NUMERIC, 10::NUMERIC, 1000000::NUMERIC, 10::NUMERIC),
            ('fateclaw_insight', 30::NUMERIC, 30::NUMERIC, 3500000::NUMERIC, 10::NUMERIC),
            ('fateclaw_deep', 100::NUMERIC, 100::NUMERIC, 13000000::NUMERIC, 10::NUMERIC)
        )
        UPDATE membership_config config
        SET monthly_price_coins = defaults.monthly_price_coins,
            display_price_coins = defaults.display_price_coins,
            monthly_allowance_units = defaults.monthly_allowance_units,
            standard_price_per_million_units_coins =
              defaults.standard_price_per_million_units_coins,
            updated_at = NOW()
        FROM defaults
        WHERE config.id = defaults.id
          AND (
            (
              config.id = 'fateclaw_clarity'
              AND config.monthly_price_coins = 10
              AND config.display_price_coins = 10
              AND config.monthly_allowance_units = 0
              AND config.standard_price_per_million_units_coins = 10
            )
            OR (
              config.id = 'fateclaw_insight'
              AND config.monthly_price_coins = 30
              AND config.display_price_coins = 30
              AND config.monthly_allowance_units = 3000000
              AND config.standard_price_per_million_units_coins = 10
            )
            OR (
              config.id = 'fateclaw_deep'
              AND config.monthly_price_coins = 100
              AND config.display_price_coins = 120
              AND config.monthly_allowance_units IN (3000000, 10000000)
              AND config.standard_price_per_million_units_coins = 10
            )
          )
      `);
    },
  },
];
