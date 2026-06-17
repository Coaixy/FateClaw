import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段：0045。
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
];
