import type { DatabaseMigration } from '../types.js';
import { ensureCheckConstraint } from '../helpers.js';

/**
 * 数据库迁移分段：0012-0019。
 */
export const financeArchiveMigrations: readonly DatabaseMigration[] = [
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
  {
    id: '0017_membership_token_plan',
    description: '增加 FateClaw Plus 会员与月度额度 schema',
    async up(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS membership_config (
          id TEXT PRIMARY KEY DEFAULT 'default',
          enabled BOOLEAN NOT NULL DEFAULT true,
          monthly_price_coins NUMERIC(14,2) NOT NULL DEFAULT 30,
          monthly_allowance_units NUMERIC(18,2) NOT NULL DEFAULT 3000000,
          standard_price_per_million_units_coins NUMERIC(14,2) NOT NULL DEFAULT 10,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        INSERT INTO membership_config (id)
        VALUES ('default')
        ON CONFLICT (id) DO NOTHING
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_memberships (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          plan_key TEXT NOT NULL DEFAULT 'fateclaw_plus',
          status TEXT NOT NULL DEFAULT 'active',
          current_period_start TIMESTAMPTZ NOT NULL,
          current_period_end TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS membership_allowances (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          plan_key TEXT NOT NULL DEFAULT 'fateclaw_plus',
          period_start TIMESTAMPTZ NOT NULL,
          period_end TIMESTAMPTZ NOT NULL,
          allowance_units NUMERIC(18,2) NOT NULL,
          used_units NUMERIC(18,2) NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (user_id, period_start)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_memberships_active_period
          ON user_memberships(status, current_period_end);
        CREATE INDEX IF NOT EXISTS idx_membership_allowances_user_period
          ON membership_allowances(user_id, period_start DESC);
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_membership_config_price_nonnegative',
        tableName: 'membership_config',
        expression: 'monthly_price_coins >= 0',
        cleanupSql: `UPDATE membership_config
                     SET monthly_price_coins = 30
                     WHERE monthly_price_coins < 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_membership_config_allowance_positive',
        tableName: 'membership_config',
        expression: 'monthly_allowance_units > 0',
        cleanupSql: `UPDATE membership_config
                     SET monthly_allowance_units = 3000000
                     WHERE monthly_allowance_units <= 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_membership_config_standard_price_positive',
        tableName: 'membership_config',
        expression: 'standard_price_per_million_units_coins > 0',
        cleanupSql: `UPDATE membership_config
                     SET standard_price_per_million_units_coins = 10
                     WHERE standard_price_per_million_units_coins <= 0`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_user_memberships_status_valid',
        tableName: 'user_memberships',
        expression: "status IN ('active', 'cancelled')",
        cleanupSql: `UPDATE user_memberships
                     SET status = 'cancelled'
                     WHERE status NOT IN ('active', 'cancelled')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_user_memberships_period_valid',
        tableName: 'user_memberships',
        expression: 'current_period_end > current_period_start',
        cleanupSql: `UPDATE user_memberships
                     SET current_period_start = LEAST(current_period_start, NOW()),
                         current_period_end = GREATEST(current_period_end, NOW() + INTERVAL '1 month')
                     WHERE current_period_end <= current_period_start`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_membership_allowances_units_valid',
        tableName: 'membership_allowances',
        expression: 'allowance_units > 0 AND used_units >= 0',
        cleanupSql: `UPDATE membership_allowances
                     SET allowance_units = GREATEST(allowance_units, 1),
                         used_units = GREATEST(used_units, 0)
                     WHERE allowance_units <= 0 OR used_units < 0`,
      });
    },
  },
  {
    id: '0018_chat_session_archive_and_share',
    description: '增加 AI Chat 会话分享与 Pi session 数据库归档 schema',
    async up(client) {
      await client.query(`
        ALTER TABLE chat_sessions
          ADD COLUMN IF NOT EXISTS share_token TEXT DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS share_created_at TIMESTAMPTZ DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS pi_session_archived_at TIMESTAMPTZ DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS pi_session_archive_reason TEXT DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS pi_session_archive_payload JSONB DEFAULT NULL,
          ADD COLUMN IF NOT EXISTS pi_session_archive_restored_at TIMESTAMPTZ DEFAULT NULL
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_share_token
          ON chat_sessions(share_token)
          WHERE share_token IS NOT NULL
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS pi_session_cleanup_cursors (
          mode TEXT PRIMARY KEY,
          cursor_session_id TEXT DEFAULT NULL,
          scanned_sessions INTEGER NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_chat_sessions_pi_archive_reason_valid',
        tableName: 'chat_sessions',
        expression:
          "pi_session_archive_reason IS NULL OR pi_session_archive_reason IN ('soft_deleted', 'inactive')",
        cleanupSql: `UPDATE chat_sessions
                     SET pi_session_archive_reason = NULL
                     WHERE pi_session_archive_reason IS NOT NULL
                       AND pi_session_archive_reason NOT IN ('soft_deleted', 'inactive')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_pi_session_cleanup_cursors_mode_valid',
        tableName: 'pi_session_cleanup_cursors',
        expression: "mode IN ('soft_deleted', 'inactive')",
        cleanupSql: `DELETE FROM pi_session_cleanup_cursors
                     WHERE mode NOT IN ('soft_deleted', 'inactive')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_pi_session_cleanup_cursors_scanned_nonnegative',
        tableName: 'pi_session_cleanup_cursors',
        expression: 'scanned_sessions >= 0',
        cleanupSql: `UPDATE pi_session_cleanup_cursors
                     SET scanned_sessions = 0
                     WHERE scanned_sessions < 0`,
      });
    },
  },
  {
    id: '0019_user_soul_edit_enabled',
    description: '增加用户级 Soul 对话编辑开关',
    async up(client) {
      await client.query(`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS soul_edit_enabled BOOLEAN NOT NULL DEFAULT true
      `);
    },
  },
];
