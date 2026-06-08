import type { DatabaseMigration } from '../types.js';
import {
  dropLegacyUserCustomSkillRoutingColumns,
  ensureCheckConstraint,
  ensureForeignKey,
  migrateLegacyUserCustomSkillContentToBundles,
  migrateLegacyUserCustomSkillRoutingToBundles,
} from '../helpers.js';

/**
 * 数据库迁移分段：0003。
 */
export const applicationSchemaMigrations: readonly DatabaseMigration[] = [
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
        `ALTER TABLE user_skill_subscriptions ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'share'`,
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
      await client.query(`
        UPDATE user_skill_subscriptions sub
        SET source_kind = 'bundle_share'
        WHERE sub.has_direct_source = false
          AND sub.source_kind = 'share'
          AND EXISTS (
            SELECT 1
            FROM user_skill_subscription_bundle_sources src
            WHERE src.subscription_id = sub.id
          )
      `);
      await client.query(
        `ALTER TABLE user_skill_subscriptions DROP COLUMN IF EXISTS source_bundle_id`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS skill_access_invites (
          id TEXT PRIMARY KEY,
          creator_id TEXT NOT NULL REFERENCES users(id),
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          token TEXT NOT NULL UNIQUE,
          max_redemptions INTEGER NOT NULL DEFAULT 1,
          redeemed_count INTEGER NOT NULL DEFAULT 0,
          expires_at TIMESTAMPTZ DEFAULT NULL,
          revoked_at TIMESTAMPTZ DEFAULT NULL,
          note TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_skill_access_invites_creator_target
         ON skill_access_invites(creator_id, target_type, target_id, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_skill_access_invites_token
         ON skill_access_invites(token)`,
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
        constraintName: 'chk_user_skill_subscriptions_source_kind_valid',
        tableName: 'user_skill_subscriptions',
        expression: `source_kind IN ('share', 'bundle_share', 'invite', 'bundle_invite')`,
        cleanupSql: `UPDATE user_skill_subscriptions
                     SET source_kind = 'share'
                     WHERE source_kind NOT IN ('share', 'bundle_share', 'invite', 'bundle_invite')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_skill_access_invites_target_type_valid',
        tableName: 'skill_access_invites',
        expression: `target_type IN ('skill', 'bundle')`,
        cleanupSql: `UPDATE skill_access_invites
                     SET target_type = 'skill'
                     WHERE target_type NOT IN ('skill', 'bundle')`,
      });
      await ensureCheckConstraint(client, {
        constraintName: 'chk_skill_access_invites_redemptions_valid',
        tableName: 'skill_access_invites',
        expression: `max_redemptions > 0 AND redeemed_count >= 0 AND redeemed_count <= max_redemptions`,
        cleanupSql: `UPDATE skill_access_invites
                     SET max_redemptions = GREATEST(1, max_redemptions),
                         redeemed_count = LEAST(GREATEST(0, redeemed_count), GREATEST(1, max_redemptions))`,
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
        expression: 'remaining_cents >= 0 AND remaining_cents <= amount_cents',
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
];
