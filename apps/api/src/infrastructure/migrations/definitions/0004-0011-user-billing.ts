import type { DatabaseMigration } from '../types.js';
import { deleteUsersWithoutValidPhone } from '../../phone-only-user-migration.js';
import { ensureCheckConstraint } from '../helpers.js';

/**
 * 数据库迁移分段：0004-0011。
 */
export const userBillingMigrations: readonly DatabaseMigration[] = [
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
      await client.query(`DROP INDEX IF EXISTS idx_balance_grants_user_active`);
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
        constraintName:
          'chk_billing_request_reservations_reserved_coins_nonnegative',
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
];
