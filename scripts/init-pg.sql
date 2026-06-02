-- FateClaw PostgreSQL schema
-- 常规启动由 API 的 initDatabase() 自动建表和补列；此脚本仅作为 schema 参考/兼容入口。

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  phone_verified BOOLEAN NOT NULL DEFAULT true,
  password_hash TEXT NOT NULL,
  soul_content TEXT NOT NULL DEFAULT '',
  soul_edit_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE users
  DROP COLUMN IF EXISTS plan,
  DROP COLUMN IF EXISTS subscribed_at,
  DROP COLUMN IF EXISTS expires_at;

CREATE TABLE IF NOT EXISTS daily_usage (
  user_id TEXT NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  msg_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

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
);

-- 系统排盘全局配置：后台控制的全局开关
CREATE TABLE IF NOT EXISTS skill_global_config (
  skill_name TEXT PRIMARY KEY,
  globally_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT DEFAULT NULL
);

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
  PRIMARY KEY (id, account_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);
-- 兼容已有数据库
ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_context TEXT DEFAULT NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS session_id TEXT DEFAULT NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT NULL REFERENCES users(id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id);
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_account_timestamp_active
  ON messages(account_id, timestamp DESC)
  WHERE deleted_at IS NULL AND session_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp_active
  ON messages(session_id, timestamp DESC)
  WHERE deleted_at IS NULL AND session_id IS NOT NULL;

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
  deleted_at TIMESTAMPTZ DEFAULT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON scheduled_tasks(next_run);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON scheduled_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_account ON scheduled_tasks(account_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due_lock
  ON scheduled_tasks(status, next_run, scheduler_locked_until)
  WHERE deleted_at IS NULL;

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
);
CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

-- 清理已废弃的历史表
DROP TABLE IF EXISTS xs_apis;

-- 用户自定义知识 Skill（纯知识库，无脚本执行）
CREATE TABLE IF NOT EXISTS user_custom_skills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
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
  deleted_at TIMESTAMPTZ DEFAULT NULL
);
ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS version TEXT NOT NULL DEFAULT '1.0.0';
ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS bundle_uri TEXT NOT NULL DEFAULT '';
ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS checksum TEXT DEFAULT NULL;
ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS install_status TEXT NOT NULL DEFAULT 'missing';
ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS acl JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS billing_policy JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS audit_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS stat_subscriber_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_custom_skills ADD COLUMN IF NOT EXISTS stat_view_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS trigger_hint;
ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS category;
ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS category_normalized;
ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS match_keywords;
ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS match_patterns;
ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS example_queries;
ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS priority;
ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS usage_mode;
CREATE INDEX IF NOT EXISTS idx_ucs_user ON user_custom_skills(user_id);
CREATE INDEX IF NOT EXISTS idx_ucs_share_token ON user_custom_skills(share_token);
-- 修复：唯一约束排除软删除行，避免同名 skill 删除后无法重建
ALTER TABLE user_custom_skills DROP CONSTRAINT IF EXISTS user_custom_skills_user_id_dir_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ucs_user_dir_active
  ON user_custom_skills(user_id, dir_name) WHERE deleted_at IS NULL;
-- 旧知识正文迁移到文件系统 Text Skill Bundle 由 initDatabase() 完成；
-- 纯 SQL 脚本只保留新控制平面 schema，不负责写入 bundle 文件。
DROP TABLE IF EXISTS user_custom_skill_contents;

-- 用户 Skill 订阅关系（引用订阅模式）
CREATE TABLE IF NOT EXISTS user_skill_subscriptions (
  id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL REFERENCES users(id),
  skill_id TEXT NOT NULL REFERENCES user_custom_skills(id),
  enabled BOOLEAN NOT NULL DEFAULT true,
  subscribed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(subscriber_id, skill_id)
);
ALTER TABLE user_skill_subscriptions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE user_skill_subscriptions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE user_skill_subscriptions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE user_skill_subscriptions ADD COLUMN IF NOT EXISTS has_direct_source BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS idx_uss_subscriber ON user_skill_subscriptions(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_uss_skill ON user_skill_subscriptions(skill_id);
CREATE INDEX IF NOT EXISTS idx_uss_subscriber_enabled_active_expiry
  ON user_skill_subscriptions(subscriber_id, expires_at)
  WHERE enabled = true AND status = 'active';
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
  AND s.stat_subscriber_count IS DISTINCT FROM COALESCE(sc.cnt, 0);
ALTER TABLE user_custom_skills DROP COLUMN IF EXISTS content;

-- Skill 捆绑包：创作者自由组合多个自有 skill 生成独立分享链接
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
);
CREATE TABLE IF NOT EXISTS skill_bundle_items (
  bundle_id TEXT NOT NULL REFERENCES skill_bundles(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES user_custom_skills(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bundle_id, skill_id)
);
CREATE INDEX IF NOT EXISTS idx_skill_bundles_user ON skill_bundles(user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_skill_bundles_token ON skill_bundles(bundle_token) WHERE bundle_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_bundle_items_bundle_order
  ON skill_bundle_items(bundle_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_skill_bundle_items_skill
  ON skill_bundle_items(skill_id);
DO $$
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
END $$;
ALTER TABLE skill_bundles DROP COLUMN IF EXISTS skill_ids;
CREATE TABLE IF NOT EXISTS user_skill_subscription_bundle_sources (
  subscription_id TEXT NOT NULL REFERENCES user_skill_subscriptions(id) ON DELETE CASCADE,
  bundle_id TEXT NOT NULL REFERENCES skill_bundles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (subscription_id, bundle_id)
);
CREATE INDEX IF NOT EXISTS idx_uss_bundle_sources_bundle
  ON user_skill_subscription_bundle_sources(bundle_id);
DO $$
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
END $$;
ALTER TABLE user_skill_subscriptions DROP COLUMN IF EXISTS source_bundle_id;
CREATE INDEX IF NOT EXISTS idx_ucs_market_listing
  ON user_custom_skills(stat_subscriber_count DESC, created_at DESC)
  WHERE deleted_at IS NULL AND visibility = 'shared';
DROP INDEX IF EXISTS idx_ucs_market_category_listing;

-- 对话日志：完整 transcript（工具调用链 + 参数 + 输出），用于 debug
CREATE TABLE IF NOT EXISTS conversation_logs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  request_id TEXT NOT NULL,
  usage JSONB DEFAULT NULL,
  model TEXT DEFAULT NULL,
  provider TEXT DEFAULT NULL,
  transcript_event_count INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  trace_event_count INTEGER NOT NULL DEFAULT 0,
  agent_graph_summary JSONB DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS conversation_log_payloads (
  log_id TEXT PRIMARY KEY REFERENCES conversation_logs(id) ON DELETE CASCADE,
  transcript JSONB NOT NULL DEFAULT '[]',
  trace_events JSONB DEFAULT NULL,
  agent_graph JSONB DEFAULT NULL
);
ALTER TABLE conversation_logs ADD COLUMN IF NOT EXISTS transcript_event_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_logs ADD COLUMN IF NOT EXISTS tool_call_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_logs ADD COLUMN IF NOT EXISTS trace_event_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_logs ADD COLUMN IF NOT EXISTS agent_graph_summary JSONB DEFAULT NULL;
ALTER TABLE conversation_logs DROP COLUMN IF EXISTS routing_decision;
CREATE INDEX IF NOT EXISTS idx_conv_logs_account ON conversation_logs(account_id);
CREATE INDEX IF NOT EXISTS idx_conv_logs_created ON conversation_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_conversation_logs_request_id ON conversation_logs(request_id);

DO $$
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
END $$;

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
  );

ALTER TABLE conversation_logs
  DROP COLUMN IF EXISTS transcript,
  DROP COLUMN IF EXISTS trace_events,
  DROP COLUMN IF EXISTS agent_graph;

-- users 加 role 字段，区分消费者 / 创作者 / 双重 / 管理员
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'consumer';
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT true;

-- =====================
-- 宿主运行时扩展：会话 / 钱包
-- =====================

ALTER TABLE users ADD COLUMN IF NOT EXISTS purchased_points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reserved_points INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  user_id TEXT DEFAULT NULL REFERENCES users(id),
  title TEXT NOT NULL DEFAULT '',
  share_token TEXT DEFAULT NULL,
  share_created_at TIMESTAMPTZ DEFAULT NULL,
  pi_session_archived_at TIMESTAMPTZ DEFAULT NULL,
  pi_session_archive_reason TEXT DEFAULT NULL,
  pi_session_archive_payload JSONB DEFAULT NULL,
  pi_session_archive_restored_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ DEFAULT NULL
);
ALTER TABLE chat_sessions DROP CONSTRAINT IF EXISTS chat_sessions_account_id_fkey;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT NULL REFERENCES users(id);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS share_token TEXT DEFAULT NULL;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS share_created_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pi_session_archived_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pi_session_archive_reason TEXT DEFAULT NULL;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pi_session_archive_payload JSONB DEFAULT NULL;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pi_session_archive_restored_at TIMESTAMPTZ DEFAULT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_share_token
  ON chat_sessions(share_token)
  WHERE share_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_account_updated
  ON chat_sessions(account_id, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_updated
  ON chat_sessions(user_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS pi_session_cleanup_cursors (
  mode TEXT PRIMARY KEY,
  cursor_session_id TEXT DEFAULT NULL,
  scanned_sessions INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_messages_session_id') THEN
    ALTER TABLE messages
      ADD CONSTRAINT fk_messages_session_id
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE SET NULL;
  END IF;
END $$;

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
);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_created_at ON wallet_transactions(user_id, created_at DESC);

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
);
INSERT INTO recharge_payment_config (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;

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
);
CREATE INDEX IF NOT EXISTS idx_recharge_orders_user_created_at
  ON recharge_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recharge_orders_status_created_at
  ON recharge_orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recharge_orders_status_paid_at
  ON recharge_orders(status, paid_at DESC)
  WHERE paid_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS monthly_billing_state (
  user_id TEXT NOT NULL REFERENCES users(id),
  year_month TEXT NOT NULL,
  billed_overage_tokens INTEGER NOT NULL DEFAULT 0,
  billed_overage_cost_points INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, year_month)
);

CREATE TABLE IF NOT EXISTS billing_request_reservations (
  request_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  plan_id TEXT DEFAULT NULL,
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
);
CREATE INDEX IF NOT EXISTS idx_billing_request_reservations_user_created_at
  ON billing_request_reservations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_request_reservations_hold_state
  ON billing_request_reservations(hold_state, charge_state, updated_at);

CREATE TABLE IF NOT EXISTS point_batches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  source TEXT NOT NULL,
  granted_by TEXT DEFAULT NULL,
  amount_points INTEGER NOT NULL CHECK (amount_points > 0),
  remaining_points INTEGER NOT NULL,
  note TEXT DEFAULT NULL,
  expires_at TIMESTAMPTZ DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_point_batches_user_active
  ON point_batches(user_id, expires_at, remaining_points)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_point_batches_expiry_scan
  ON point_batches(expires_at)
  WHERE status = 'active' AND expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS membership_config (
  id TEXT PRIMARY KEY DEFAULT 'default',
  enabled BOOLEAN NOT NULL DEFAULT true,
  monthly_price_coins NUMERIC(14,2) NOT NULL DEFAULT 30,
  monthly_allowance_units NUMERIC(18,2) NOT NULL DEFAULT 3000000,
  standard_price_per_million_units_coins NUMERIC(14,2) NOT NULL DEFAULT 10,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO membership_config (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_memberships (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan_key TEXT NOT NULL DEFAULT 'fateclaw_plus',
  status TEXT NOT NULL DEFAULT 'active',
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_memberships_active_period
  ON user_memberships(status, current_period_end);

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
);
CREATE INDEX IF NOT EXISTS idx_membership_allowances_user_period
  ON membership_allowances(user_id, period_start DESC);

CREATE TABLE IF NOT EXISTS runtime_config (
  id TEXT PRIMARY KEY DEFAULT 'default',
  agent_concurrency_limit INTEGER NOT NULL DEFAULT 10,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO runtime_config (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE chat_sessions
  DROP CONSTRAINT IF EXISTS fk_chat_sessions_owner_user_id,
  DROP CONSTRAINT IF EXISTS fk_chat_sessions_persona_id,
  DROP COLUMN IF EXISTS owner_user_id,
  DROP COLUMN IF EXISTS persona_id;

DROP TABLE IF EXISTS persona_subscriptions;
DROP TABLE IF EXISTS personas;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_role_valid') THEN
    UPDATE users
    SET role = 'consumer'
    WHERE role NOT IN ('consumer', 'creator', 'both', 'admin');
    ALTER TABLE users
      ADD CONSTRAINT chk_users_role_valid
      CHECK (role IN ('consumer', 'creator', 'both', 'admin'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_custom_skills_visibility_valid') THEN
    UPDATE user_custom_skills
    SET visibility = 'private',
        share_token = NULL
    WHERE visibility NOT IN ('private', 'link_shared', 'shared');
    ALTER TABLE user_custom_skills
      ADD CONSTRAINT chk_user_custom_skills_visibility_valid
      CHECK (visibility IN ('private', 'link_shared', 'shared'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_skill_bundles_visibility_valid') THEN
    UPDATE skill_bundles
    SET visibility = 'private',
        bundle_token = NULL
    WHERE visibility NOT IN ('private', 'link_shared', 'shared');
    ALTER TABLE skill_bundles
      ADD CONSTRAINT chk_skill_bundles_visibility_valid
      CHECK (visibility IN ('private', 'link_shared', 'shared'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_skill_subscriptions_status_valid') THEN
    UPDATE user_skill_subscriptions
    SET status = 'active'
    WHERE status NOT IN ('active', 'expired', 'cancelled');
    ALTER TABLE user_skill_subscriptions
      ADD CONSTRAINT chk_user_skill_subscriptions_status_valid
      CHECK (status IN ('active', 'expired', 'cancelled'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_scheduled_tasks_schedule_type_valid') THEN
    UPDATE scheduled_tasks
    SET schedule_type = 'once'
    WHERE schedule_type NOT IN ('cron', 'interval', 'once');
    ALTER TABLE scheduled_tasks
      ADD CONSTRAINT chk_scheduled_tasks_schedule_type_valid
      CHECK (schedule_type IN ('cron', 'interval', 'once'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_scheduled_tasks_status_valid') THEN
    UPDATE scheduled_tasks
    SET status = 'active'
    WHERE status NOT IN ('active', 'paused', 'completed');
    ALTER TABLE scheduled_tasks
      ADD CONSTRAINT chk_scheduled_tasks_status_valid
      CHECK (status IN ('active', 'paused', 'completed'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_billing_request_reservations_hold_state_valid') THEN
    UPDATE billing_request_reservations
    SET hold_state = 'none'
    WHERE hold_state NOT IN ('none', 'held', 'released');
    ALTER TABLE billing_request_reservations
      ADD CONSTRAINT chk_billing_request_reservations_hold_state_valid
      CHECK (hold_state IN ('none', 'held', 'released'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_billing_request_reservations_charge_state_valid') THEN
    UPDATE billing_request_reservations
    SET charge_state = 'pending'
    WHERE charge_state NOT IN ('pending', 'charged');
    ALTER TABLE billing_request_reservations
      ADD CONSTRAINT chk_billing_request_reservations_charge_state_valid
      CHECK (charge_state IN ('pending', 'charged'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_billing_request_reservations_reserved_points_nonnegative') THEN
    UPDATE billing_request_reservations
    SET reserved_points = 0
    WHERE reserved_points < 0;
    ALTER TABLE billing_request_reservations
      ADD CONSTRAINT chk_billing_request_reservations_reserved_points_nonnegative
      CHECK (reserved_points >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_billing_request_reservations_actual_charge_points_nonnegative') THEN
    UPDATE billing_request_reservations
    SET actual_charge_points = 0
    WHERE actual_charge_points < 0;
    ALTER TABLE billing_request_reservations
      ADD CONSTRAINT chk_billing_request_reservations_actual_charge_points_nonnegative
      CHECK (actual_charge_points >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_billing_request_reservations_total_overage_tokens_nonnegative') THEN
    UPDATE billing_request_reservations
    SET total_overage_tokens = 0
    WHERE total_overage_tokens < 0;
    ALTER TABLE billing_request_reservations
      ADD CONSTRAINT chk_billing_request_reservations_total_overage_tokens_nonnegative
      CHECK (total_overage_tokens >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_billing_request_reservations_total_overage_cost_points_nonnegative') THEN
    UPDATE billing_request_reservations
    SET total_overage_cost_points = 0
    WHERE total_overage_cost_points < 0;
    ALTER TABLE billing_request_reservations
      ADD CONSTRAINT chk_billing_request_reservations_total_overage_cost_points_nonnegative
      CHECK (total_overage_cost_points >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_recharge_payment_config_min_yuan_positive') THEN
    UPDATE recharge_payment_config
    SET min_yuan = 1
    WHERE min_yuan <= 0;
    ALTER TABLE recharge_payment_config
      ADD CONSTRAINT chk_recharge_payment_config_min_yuan_positive
      CHECK (min_yuan > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_recharge_payment_config_max_yuan_valid') THEN
    UPDATE recharge_payment_config
    SET max_yuan = GREATEST(min_yuan, 1000)
    WHERE max_yuan < min_yuan;
    ALTER TABLE recharge_payment_config
      ADD CONSTRAINT chk_recharge_payment_config_max_yuan_valid
      CHECK (max_yuan >= min_yuan);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_recharge_payment_config_platform_id_positive') THEN
    UPDATE recharge_payment_config
    SET epay_platform_id = NULL
    WHERE epay_platform_id IS NOT NULL AND epay_platform_id <= 0;
    ALTER TABLE recharge_payment_config
      ADD CONSTRAINT chk_recharge_payment_config_platform_id_positive
      CHECK (epay_platform_id IS NULL OR epay_platform_id > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_recharge_orders_pay_type_valid') THEN
    UPDATE recharge_orders
    SET pay_type = 'alipay'
    WHERE pay_type NOT IN ('alipay', 'wechat');
    ALTER TABLE recharge_orders
      ADD CONSTRAINT chk_recharge_orders_pay_type_valid
      CHECK (pay_type IN ('alipay', 'wechat'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_recharge_orders_status_valid') THEN
    UPDATE recharge_orders
    SET status = 'pending'
    WHERE status NOT IN ('pending', 'paid', 'failed');
    ALTER TABLE recharge_orders
      ADD CONSTRAINT chk_recharge_orders_status_valid
      CHECK (status IN ('pending', 'paid', 'failed'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_recharge_orders_amount_points_positive') THEN
    UPDATE recharge_orders
    SET amount_points = 1
    WHERE amount_points <= 0;
    ALTER TABLE recharge_orders
      ADD CONSTRAINT chk_recharge_orders_amount_points_positive
      CHECK (amount_points > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_recharge_orders_amount_yuan_positive') THEN
    UPDATE recharge_orders
    SET amount_yuan = 0.01
    WHERE amount_yuan <= 0;
    ALTER TABLE recharge_orders
      ADD CONSTRAINT chk_recharge_orders_amount_yuan_positive
      CHECK (amount_yuan > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_point_batches_status_valid') THEN
    UPDATE point_batches
    SET status = 'active'
    WHERE status NOT IN ('active', 'exhausted', 'expired', 'revoked');
    ALTER TABLE point_batches
      ADD CONSTRAINT chk_point_batches_status_valid
      CHECK (status IN ('active', 'exhausted', 'expired', 'revoked'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_point_batches_remaining_points_range') THEN
    UPDATE point_batches
    SET remaining_points = LEAST(amount_points, GREATEST(remaining_points, 0))
    WHERE remaining_points < 0 OR remaining_points > amount_points;
    ALTER TABLE point_batches
      ADD CONSTRAINT chk_point_batches_remaining_points_range
      CHECK (remaining_points >= 0 AND remaining_points <= amount_points);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_membership_config_price_nonnegative') THEN
    UPDATE membership_config
    SET monthly_price_coins = 30
    WHERE monthly_price_coins < 0;
    ALTER TABLE membership_config
      ADD CONSTRAINT chk_membership_config_price_nonnegative
      CHECK (monthly_price_coins >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_membership_config_allowance_positive') THEN
    UPDATE membership_config
    SET monthly_allowance_units = 3000000
    WHERE monthly_allowance_units <= 0;
    ALTER TABLE membership_config
      ADD CONSTRAINT chk_membership_config_allowance_positive
      CHECK (monthly_allowance_units > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_membership_config_standard_price_positive') THEN
    UPDATE membership_config
    SET standard_price_per_million_units_coins = 10
    WHERE standard_price_per_million_units_coins <= 0;
    ALTER TABLE membership_config
      ADD CONSTRAINT chk_membership_config_standard_price_positive
      CHECK (standard_price_per_million_units_coins > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_memberships_status_valid') THEN
    UPDATE user_memberships
    SET status = 'cancelled'
    WHERE status NOT IN ('active', 'cancelled');
    ALTER TABLE user_memberships
      ADD CONSTRAINT chk_user_memberships_status_valid
      CHECK (status IN ('active', 'cancelled'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_memberships_period_valid') THEN
    UPDATE user_memberships
    SET current_period_start = LEAST(current_period_start, NOW()),
        current_period_end = GREATEST(current_period_end, NOW() + INTERVAL '1 month')
    WHERE current_period_end <= current_period_start;
    ALTER TABLE user_memberships
      ADD CONSTRAINT chk_user_memberships_period_valid
      CHECK (current_period_end > current_period_start);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_membership_allowances_units_valid') THEN
    UPDATE membership_allowances
    SET allowance_units = GREATEST(allowance_units, 1),
        used_units = GREATEST(used_units, 0)
    WHERE allowance_units <= 0 OR used_units < 0;
    ALTER TABLE membership_allowances
      ADD CONSTRAINT chk_membership_allowances_units_valid
      CHECK (allowance_units > 0 AND used_units >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_runtime_config_agent_concurrency_limit_positive') THEN
    UPDATE runtime_config
    SET agent_concurrency_limit = 10
    WHERE agent_concurrency_limit <= 0;
    ALTER TABLE runtime_config
      ADD CONSTRAINT chk_runtime_config_agent_concurrency_limit_positive
      CHECK (agent_concurrency_limit > 0);
  END IF;
END $$;

ALTER TABLE users DROP COLUMN IF EXISTS email;
ALTER TABLE users ALTER COLUMN phone_verified SET DEFAULT true;
DROP INDEX IF EXISTS idx_users_email_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique ON users(phone);
