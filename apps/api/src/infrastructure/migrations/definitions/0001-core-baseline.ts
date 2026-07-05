import type pg from "pg";

import type { DatabaseMigration } from "../types.js";

/**
 * 全量基线 schema。
 *
 * @remarks
 * 本基线把历史 0001-0067 共 67 条迁移压平为单一基线，等价重建相同 schema 与默认配置种子。
 * 内容由「干净库跑完全部历史迁移后 pg_dump（--column-inserts，剔除 schema_migrations 与 psql 元命令）」生成，
 * 并经「重放后再次 pg_dump 与原迁移产出逐行比对」验证 schema 完全等价。
 *
 * 关键约束（务必遵守）：
 * - id 复用历史首条 \`0001_core_schema_baseline\`：已存在的库都已记录该 id 会自动跳过本基线、保留现有 schema；
 *   只有从未记录该 id 的全新空库才会执行本基线一次性建全。
 * - 因此本基线只会在空库上运行，使用裸 \`CREATE TABLE\` 即可，无需幂等。
 * - 新增迁移一律在 definitions.ts 的 MIGRATIONS 数组末尾追加，切勿改写本基线或复用已发布 id。
 *
 * 修订记录（与 DROP 迁移双写，保持新旧库 schema 收敛）：
 * - 2026-07-05：移除 4 张死功能表定义（simple_workflow_presets、ai_chat_free_daily_usage、
 *   ai_chat_free_quota_config、ai_chat_professional_daily_usage）。存量库由 0073 迁移 DROP 同名表，
 *   全新库直接不建，两条路径最终 schema 一致（背景见 0073 文件注释）。
 * - 2026-07-05（补充轮）：移除 9 张已删功能残留表定义（礼品码 gift_codes/gift_code_redemptions、
 *   邀请返利 referral_config/referral_reward_events/user_referrals/user_invite_codes、
 *   每日签到 daily_sign_in_config/daily_sign_in_records、技能点赞 skill_reactions）。
 *   存量库由 0074 迁移 DROP 同名表（背景见 0074 文件注释）。
 */
const BASELINE_SQL = `
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE TABLE public.accounts (
    id text NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    bot_token text NOT NULL,
    base_url text NOT NULL,
    soul_content text DEFAULT ''::text,
    get_updates_buf text DEFAULT ''::text,
    enabled boolean DEFAULT true,
    created_at timestamp with time zone NOT NULL,
    owner_id text
);

CREATE TABLE public.announcements (
    id text NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    body_markdown text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    cta_label text,
    cta_href text,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_announcements_content_lengths CHECK ((((char_length(title) >= 1) AND (char_length(title) <= 120)) AND (char_length(summary) <= 280) AND ((char_length(body_markdown) >= 1) AND (char_length(body_markdown) <= 20000)) AND ((cta_label IS NULL) OR ((char_length(cta_label) >= 1) AND (char_length(cta_label) <= 40))))),
    CONSTRAINT chk_announcements_cta_href_safe CHECK (((cta_href IS NULL) OR ((cta_href ~~ '/%'::text) AND (cta_href !~~ '//%'::text)) OR (cta_href ~~ 'https://%'::text))),
    CONSTRAINT chk_announcements_cta_pair CHECK ((((cta_label IS NULL) AND (cta_href IS NULL)) OR ((cta_label IS NOT NULL) AND (cta_href IS NOT NULL)))),
    CONSTRAINT chk_announcements_slug_format CHECK ((((char_length(slug) >= 1) AND (char_length(slug) <= 80)) AND (slug ~ '^[a-z0-9][a-z0-9-]*$'::text))),
    CONSTRAINT chk_announcements_status_valid CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'archived'::text]))),
    CONSTRAINT chk_announcements_time_window CHECK (((ends_at IS NULL) OR (starts_at IS NULL) OR (ends_at > starts_at)))
);

CREATE TABLE public.balance_grants (
    id text NOT NULL,
    user_id text NOT NULL,
    source text NOT NULL,
    granted_by text,
    note text,
    expires_at timestamp with time zone,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    amount_coins numeric(14,2) DEFAULT 0 NOT NULL,
    remaining_coins numeric(14,2) DEFAULT 0 NOT NULL,
    CONSTRAINT chk_balance_grants_remaining_coins_range CHECK (((amount_coins > (0)::numeric) AND (remaining_coins >= (0)::numeric) AND (remaining_coins <= amount_coins))),
    CONSTRAINT chk_balance_grants_status_valid CHECK ((status = ANY (ARRAY['active'::text, 'exhausted'::text, 'expired'::text, 'revoked'::text])))
);

CREATE TABLE public.bazi_cases (
    id integer NOT NULL,
    bazi text NOT NULL,
    gender text NOT NULL,
    marriage text,
    children_desc text,
    abortions_size integer,
    child_deaths_size integer,
    current_education text,
    current_parent text,
    init_wealth text,
    current_wealth text,
    job text,
    job_type text,
    job_info text,
    solar_date date,
    solar_hour integer
);

CREATE TABLE public.billing_request_reservations (
    request_id text NOT NULL,
    user_id text NOT NULL,
    model_config_id text,
    year_month text NOT NULL,
    hold_state text DEFAULT 'none'::text NOT NULL,
    charge_state text DEFAULT 'pending'::text NOT NULL,
    total_overage_tokens integer DEFAULT 0 NOT NULL,
    note text,
    metadata jsonb,
    released_at timestamp with time zone,
    charged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    reserved_coins numeric(14,2) DEFAULT 0 NOT NULL,
    actual_charge_coins numeric(14,2) DEFAULT 0 NOT NULL,
    total_overage_cost_coins numeric(14,2) DEFAULT 0 NOT NULL,
    CONSTRAINT chk_billing_request_reservations_actual_charge_coins_nonnegativ CHECK ((actual_charge_coins >= (0)::numeric)),
    CONSTRAINT chk_billing_request_reservations_charge_state_valid CHECK ((charge_state = ANY (ARRAY['pending'::text, 'charged'::text]))),
    CONSTRAINT chk_billing_request_reservations_hold_state_valid CHECK ((hold_state = ANY (ARRAY['none'::text, 'held'::text, 'released'::text]))),
    CONSTRAINT chk_billing_request_reservations_reserved_coins_nonnegative CHECK ((reserved_coins >= (0)::numeric)),
    CONSTRAINT chk_billing_request_reservations_total_overage_cost_coins_nonne CHECK ((total_overage_cost_coins >= (0)::numeric)),
    CONSTRAINT chk_billing_request_reservations_total_overage_tokens_nonnegati CHECK ((total_overage_tokens >= 0))
);

CREATE TABLE public.chat_sessions (
    id text NOT NULL,
    account_id text NOT NULL,
    user_id text,
    title text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    share_token text,
    share_created_at timestamp with time zone,
    pi_session_archived_at timestamp with time zone,
    pi_session_archive_reason text,
    pi_session_archive_payload jsonb,
    pi_session_archive_restored_at timestamp with time zone,
    client_id text,
    CONSTRAINT chk_chat_sessions_pi_archive_reason_valid CHECK (((pi_session_archive_reason IS NULL) OR (pi_session_archive_reason = ANY (ARRAY['soft_deleted'::text, 'inactive'::text]))))
);

CREATE TABLE public.client_follow_ups (
    id text NOT NULL,
    user_id text NOT NULL,
    client_id text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

CREATE TABLE public.client_profiles (
    id text NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    gender text,
    solar_date text,
    hour integer,
    minute integer,
    birthplace text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    status text
);

CREATE TABLE public.config_audit_logs (
    id text NOT NULL,
    actor_user_id text,
    action text NOT NULL,
    target_type text NOT NULL,
    target_key text NOT NULL,
    before_json jsonb,
    after_json jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.conversation_log_payloads (
    log_id text NOT NULL,
    transcript jsonb DEFAULT '[]'::jsonb NOT NULL,
    trace_events jsonb,
    agent_graph jsonb
);

CREATE TABLE public.conversation_logs (
    id text NOT NULL,
    account_id text NOT NULL,
    request_id text NOT NULL,
    usage jsonb,
    model text,
    provider text,
    transcript_event_count integer DEFAULT 0 NOT NULL,
    tool_call_count integer DEFAULT 0 NOT NULL,
    trace_event_count integer DEFAULT 0 NOT NULL,
    agent_graph_summary jsonb,
    capability_ledger jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.daily_usage (
    user_id text NOT NULL,
    date text NOT NULL,
    msg_count integer DEFAULT 0,
    input_tokens integer DEFAULT 0,
    output_tokens integer DEFAULT 0,
    total_tokens integer DEFAULT 0,
    CONSTRAINT chk_daily_usage_total_tokens_nonnegative CHECK ((total_tokens >= 0))
);

CREATE TABLE public.membership_config (
    id text DEFAULT 'default'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    monthly_price_coins numeric(14,2) DEFAULT 30 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    name text DEFAULT 'FateClaw Plus'::text NOT NULL,
    display_price_coins numeric(14,2) DEFAULT 30 NOT NULL,
    CONSTRAINT chk_membership_config_display_price_nonnegative CHECK ((display_price_coins >= (0)::numeric)),
    CONSTRAINT chk_membership_config_price_nonnegative CHECK ((monthly_price_coins >= (0)::numeric))
);

CREATE TABLE public.messages (
    id text NOT NULL,
    account_id text NOT NULL,
    sender text NOT NULL,
    sender_name text NOT NULL,
    content text NOT NULL,
    "timestamp" timestamp with time zone NOT NULL,
    is_from_me boolean DEFAULT false,
    is_bot_message boolean DEFAULT false,
    deleted_at timestamp with time zone,
    tool_context text,
    session_id text,
    user_id text,
    metadata jsonb
);

CREATE TABLE public.model_billing_config (
    id text DEFAULT 'default'::text NOT NULL,
    custom_model_platform_price_per_million_coins integer DEFAULT 2 CONSTRAINT model_billing_config_custom_model_platform_price_per_m_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_model_billing_config_custom_platform_price_nonnegative CHECK ((custom_model_platform_price_per_million_coins >= 0))
);

CREATE TABLE public.monthly_billing_state (
    user_id text NOT NULL,
    year_month text NOT NULL,
    billed_overage_tokens integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    billed_overage_cost_coins numeric(14,2) DEFAULT 0 NOT NULL
);

CREATE TABLE public.official_model_configs (
    id text NOT NULL,
    model_key text NOT NULL,
    pi_api text NOT NULL,
    display_name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    base_url text,
    model_name text NOT NULL,
    api_key_secret_key text,
    extra_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    input_token_price_per_million_coins integer DEFAULT 0 CONSTRAINT official_model_configs_input_token_price_per_million__not_null1 NOT NULL,
    output_token_price_per_million_coins integer DEFAULT 0 CONSTRAINT official_model_configs_output_token_price_per_million_not_null1 NOT NULL,
    CONSTRAINT chk_official_model_configs_pi_api_valid CHECK ((pi_api = ANY (ARRAY['openai-completions'::text, 'openai-responses'::text, 'anthropic-messages'::text, 'google-generative-ai'::text])))
);

CREATE TABLE public.open_sessions (
    id text NOT NULL,
    user_id text NOT NULL,
    api_key_id text,
    runtime_session_id text NOT NULL,
    model_key text NOT NULL,
    thinking_level text,
    persona_prompt text,
    authorized_skill_ids jsonb,
    board jsonb,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_active_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT open_sessions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'deleted'::text])))
);

CREATE TABLE public.pi_session_cleanup_cursors (
    mode text NOT NULL,
    cursor_session_id text,
    scanned_sessions integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_pi_session_cleanup_cursors_mode_valid CHECK ((mode = ANY (ARRAY['soft_deleted'::text, 'inactive'::text]))),
    CONSTRAINT chk_pi_session_cleanup_cursors_scanned_nonnegative CHECK ((scanned_sessions >= 0))
);

CREATE TABLE public.public_financial_ledger_entries (
    id text NOT NULL,
    entry_type text NOT NULL,
    occurred_at date NOT NULL,
    content text NOT NULL,
    amount_yuan numeric(14,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_public_financial_ledger_amount_yuan_positive CHECK ((amount_yuan > (0)::numeric)),
    CONSTRAINT chk_public_financial_ledger_entry_type_valid CHECK ((entry_type = ANY (ARRAY['income'::text, 'expense'::text])))
);

CREATE TABLE public.recharge_orders (
    id text NOT NULL,
    user_id text NOT NULL,
    trade_id text NOT NULL,
    provider text DEFAULT 'epay'::text NOT NULL,
    provider_trade_id text,
    pay_type text NOT NULL,
    pay_url text,
    status text DEFAULT 'pending'::text NOT NULL,
    paid_at timestamp with time zone,
    notified_at timestamp with time zone,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    amount_coins numeric(14,2) DEFAULT 0 NOT NULL,
    CONSTRAINT chk_recharge_orders_amount_coins_positive CHECK ((amount_coins > (0)::numeric)),
    CONSTRAINT chk_recharge_orders_pay_type_valid CHECK ((pay_type = ANY (ARRAY['alipay'::text, 'wechat'::text]))),
    CONSTRAINT chk_recharge_orders_status_valid CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'failed'::text])))
);

CREATE TABLE public.recharge_payment_config (
    id text DEFAULT 'default'::text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    epay_url_prefix text DEFAULT ''::text NOT NULL,
    epay_platform_id integer,
    epay_merchant_private_key text DEFAULT ''::text NOT NULL,
    epay_platform_public_key text DEFAULT ''::text NOT NULL,
    epay_merchant_key text DEFAULT ''::text NOT NULL,
    notify_url text DEFAULT ''::text NOT NULL,
    return_url text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    min_coins numeric(14,2) DEFAULT 1 NOT NULL,
    max_coins numeric(14,2) DEFAULT 1000 NOT NULL,
    CONSTRAINT chk_recharge_payment_config_max_coins_valid CHECK ((max_coins >= min_coins)),
    CONSTRAINT chk_recharge_payment_config_min_coins_positive CHECK ((min_coins > (0)::numeric)),
    CONSTRAINT chk_recharge_payment_config_platform_id_positive CHECK (((epay_platform_id IS NULL) OR (epay_platform_id > 0)))
);

CREATE TABLE public.runtime_config (
    id text DEFAULT 'default'::text NOT NULL,
    agent_concurrency_limit integer DEFAULT 10 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    local_agent_max_processes integer DEFAULT 4 NOT NULL,
    local_agent_idle_ttl_ms integer DEFAULT 600000 NOT NULL,
    pi_session_health_enabled boolean DEFAULT false NOT NULL,
    pi_session_inactive_cleanup_days integer DEFAULT 30 NOT NULL,
    pi_session_orphan_grace_days integer DEFAULT 30 NOT NULL,
    skill_bundle_max_files integer DEFAULT 50 NOT NULL,
    skill_bundle_max_file_chars integer DEFAULT 100000 NOT NULL,
    skill_bundle_max_total_chars integer DEFAULT 500000 NOT NULL,
    skill_bundle_max_zip_bytes integer DEFAULT 8388608 NOT NULL,
    default_official_model_id text,
    default_thinking_level text DEFAULT 'medium'::text NOT NULL,
    user_skill_max_count integer DEFAULT 30 NOT NULL,
    CONSTRAINT chk_runtime_config_agent_concurrency_limit_positive CHECK ((agent_concurrency_limit > 0)),
    CONSTRAINT chk_runtime_config_default_thinking_level_valid CHECK ((default_thinking_level = ANY (ARRAY['off'::text, 'minimal'::text, 'low'::text, 'medium'::text, 'high'::text, 'xhigh'::text]))),
    CONSTRAINT chk_runtime_config_local_agent_idle_ttl_ms_range CHECK (((local_agent_idle_ttl_ms >= 30000) AND (local_agent_idle_ttl_ms <= 86400000))),
    CONSTRAINT chk_runtime_config_local_agent_max_processes_range CHECK (((local_agent_max_processes >= 1) AND (local_agent_max_processes <= 100))),
    CONSTRAINT chk_runtime_config_pi_session_inactive_cleanup_days_range CHECK (((pi_session_inactive_cleanup_days >= 1) AND (pi_session_inactive_cleanup_days <= 3650))),
    CONSTRAINT chk_runtime_config_pi_session_orphan_grace_days_range CHECK (((pi_session_orphan_grace_days >= 1) AND (pi_session_orphan_grace_days <= 3650))),
    CONSTRAINT chk_runtime_config_skill_bundle_max_file_chars_range CHECK (((skill_bundle_max_file_chars >= 1) AND (skill_bundle_max_file_chars <= 2000000))),
    CONSTRAINT chk_runtime_config_skill_bundle_max_files_range CHECK (((skill_bundle_max_files >= 1) AND (skill_bundle_max_files <= 500))),
    CONSTRAINT chk_runtime_config_skill_bundle_max_total_chars_range CHECK (((skill_bundle_max_total_chars >= 1) AND (skill_bundle_max_total_chars <= 10000000))),
    CONSTRAINT chk_runtime_config_skill_bundle_max_zip_bytes_range CHECK (((skill_bundle_max_zip_bytes >= 1024) AND (skill_bundle_max_zip_bytes <= 104857600))),
    CONSTRAINT chk_runtime_config_skill_bundle_total_chars_at_least_file_chars CHECK ((skill_bundle_max_total_chars >= skill_bundle_max_file_chars)),
    CONSTRAINT chk_runtime_config_user_skill_max_count_range CHECK (((user_skill_max_count >= 1) AND (user_skill_max_count <= 500)))
);

CREATE TABLE public.skill_access_invites (
    id text NOT NULL,
    creator_id text NOT NULL,
    target_type text NOT NULL,
    target_id text NOT NULL,
    token text NOT NULL,
    max_redemptions integer DEFAULT 1 NOT NULL,
    redeemed_count integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_skill_access_invites_redemptions_valid CHECK (((max_redemptions > 0) AND (redeemed_count >= 0) AND (redeemed_count <= max_redemptions))),
    CONSTRAINT chk_skill_access_invites_target_type_valid CHECK ((target_type = ANY (ARRAY['skill'::text, 'bundle'::text])))
);

CREATE TABLE public.skill_bundle_items (
    bundle_id text NOT NULL,
    skill_id text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.skill_bundles (
    id text NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    bundle_token text,
    visibility text DEFAULT 'private'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    stat_skill_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT chk_skill_bundles_visibility_valid CHECK ((visibility = ANY (ARRAY['private'::text, 'link_shared'::text, 'shared'::text])))
);

CREATE TABLE public.skill_comments (
    id text NOT NULL,
    skill_id text NOT NULL,
    user_id text NOT NULL,
    body text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    reviewed_by text,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_skill_comments_body_length CHECK (((char_length(body) >= 1) AND (char_length(body) <= 500))),
    CONSTRAINT chk_skill_comments_status_valid CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);

CREATE TABLE public.skill_global_config (
    skill_name text NOT NULL,
    globally_enabled boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text
);

CREATE TABLE public.system_secrets (
    key text NOT NULL,
    secret_value text NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.user_api_keys (
    id text NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    key_prefix text NOT NULL,
    key_hash text NOT NULL,
    last_four text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT user_api_keys_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])))
);

CREATE TABLE public.user_custom_skills (
    id text NOT NULL,
    user_id text NOT NULL,
    skill_name text NOT NULL,
    dir_name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    version text DEFAULT '1.0.0'::text NOT NULL,
    bundle_uri text DEFAULT ''::text NOT NULL,
    checksum text,
    install_status text DEFAULT 'missing'::text NOT NULL,
    acl jsonb DEFAULT '{}'::jsonb NOT NULL,
    billing_policy jsonb DEFAULT '{}'::jsonb NOT NULL,
    audit_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    visibility text DEFAULT 'private'::text NOT NULL,
    share_token text,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    stat_subscriber_count integer DEFAULT 0 NOT NULL,
    stat_view_count integer DEFAULT 0 NOT NULL,
    category text DEFAULT '通用'::text NOT NULL,
    CONSTRAINT chk_user_custom_skills_visibility_valid CHECK ((visibility = ANY (ARRAY['private'::text, 'link_shared'::text, 'shared'::text])))
);

CREATE TABLE public.user_memberships (
    user_id text NOT NULL,
    plan_key text DEFAULT 'fateclaw_plus'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    current_period_start timestamp with time zone NOT NULL,
    current_period_end timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_user_memberships_period_valid CHECK ((current_period_end > current_period_start)),
    CONSTRAINT chk_user_memberships_status_valid CHECK ((status = ANY (ARRAY['active'::text, 'cancelled'::text])))
);

CREATE TABLE public.user_model_configs (
    user_id text NOT NULL,
    pi_api text NOT NULL,
    base_url text,
    model_name text NOT NULL,
    api_key_secret_key text,
    extra_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_user_model_configs_pi_api_valid CHECK ((pi_api = ANY (ARRAY['openai-completions'::text, 'openai-responses'::text, 'anthropic-messages'::text, 'google-generative-ai'::text])))
);

CREATE TABLE public.user_model_selections (
    user_id text NOT NULL,
    source text NOT NULL,
    official_model_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    thinking_level text DEFAULT 'medium'::text NOT NULL,
    CONSTRAINT chk_user_model_selections_official_required CHECK ((((source = 'custom'::text) AND (official_model_id IS NULL)) OR ((source = 'official'::text) AND (official_model_id IS NOT NULL)))),
    CONSTRAINT chk_user_model_selections_source_valid CHECK ((source = ANY (ARRAY['custom'::text, 'official'::text]))),
    CONSTRAINT chk_user_model_selections_thinking_level_valid CHECK ((thinking_level = ANY (ARRAY['off'::text, 'minimal'::text, 'low'::text, 'medium'::text, 'high'::text, 'xhigh'::text])))
);

CREATE TABLE public.user_oauth_identities (
    provider text NOT NULL,
    provider_user_id text NOT NULL,
    user_id text NOT NULL,
    email text,
    email_verified boolean DEFAULT false NOT NULL,
    display_name text,
    avatar_url text,
    profile_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_user_oauth_identities_provider_valid CHECK ((provider = 'google'::text))
);

CREATE TABLE public.user_skill_subscription_bundle_sources (
    subscription_id text NOT NULL,
    bundle_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.user_skill_subscriptions (
    id text NOT NULL,
    subscriber_id text NOT NULL,
    skill_id text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    subscribed_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    expires_at timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    has_direct_source boolean DEFAULT true NOT NULL,
    source_kind text DEFAULT 'share'::text NOT NULL,
    CONSTRAINT chk_user_skill_subscriptions_source_kind_valid CHECK ((source_kind = ANY (ARRAY['share'::text, 'bundle_share'::text, 'invite'::text, 'bundle_invite'::text]))),
    CONSTRAINT chk_user_skill_subscriptions_status_valid CHECK ((status = ANY (ARRAY['active'::text, 'expired'::text, 'cancelled'::text])))
);

CREATE TABLE public.users (
    id text NOT NULL,
    phone text,
    phone_verified boolean DEFAULT true NOT NULL,
    password_hash text,
    auth_token_version integer DEFAULT 0 NOT NULL,
    role text DEFAULT 'consumer'::text NOT NULL,
    soul_edit_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone NOT NULL,
    soul_content text DEFAULT ''::text NOT NULL,
    purchased_coins numeric(14,2) DEFAULT 0 NOT NULL,
    bonus_coins numeric(14,2) DEFAULT 0 NOT NULL,
    reserved_coins numeric(14,2) DEFAULT 0 NOT NULL,
    guashi_script_template text DEFAULT ''::text NOT NULL,
    CONSTRAINT chk_users_auth_token_version_nonnegative CHECK ((auth_token_version >= 0)),
    CONSTRAINT chk_users_reserved_coins_nonnegative CHECK ((reserved_coins >= (0)::numeric)),
    CONSTRAINT chk_users_role_valid CHECK ((role = ANY (ARRAY['consumer'::text, 'creator'::text, 'both'::text, 'admin'::text])))
);

CREATE TABLE public.wallet_transactions (
    id text NOT NULL,
    user_id text NOT NULL,
    kind text NOT NULL,
    balance_source text,
    balance_grant_id text,
    request_id text,
    note text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    amount_coins numeric(14,2) DEFAULT 0 NOT NULL,
    reserved_delta_coins numeric(14,2) DEFAULT 0 NOT NULL
);

CREATE TABLE public.wechat_chat_session_links (
    account_id text NOT NULL,
    sender_hash text NOT NULL,
    user_id text NOT NULL,
    session_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL
);

INSERT INTO public.membership_config (id, enabled, monthly_price_coins, updated_at, name, display_price_coins) VALUES ('fateclaw_clarity', true, 66.00, '2026-06-30 12:57:53.548368+00', '卦师使用权', 66.00);

INSERT INTO public.model_billing_config (id, custom_model_platform_price_per_million_coins, updated_at) VALUES ('default', 2, '2026-06-30 12:57:53.381139+00');

INSERT INTO public.public_financial_ledger_entries (id, entry_type, occurred_at, content, amount_yuan, created_at, updated_at) VALUES ('public-ledger-seed-server-cost', 'expense', '2026-06-30', '服务器成本', 500.00, '2026-06-30 12:57:53.401681+00', '2026-06-30 12:57:53.401681+00');
INSERT INTO public.public_financial_ledger_entries (id, entry_type, occurred_at, content, amount_yuan, created_at, updated_at) VALUES ('public-ledger-seed-domain-cost', 'expense', '2026-06-30', '域名成本', 100.00, '2026-06-30 12:57:53.401681+00', '2026-06-30 12:57:53.401681+00');
INSERT INTO public.public_financial_ledger_entries (id, entry_type, occurred_at, content, amount_yuan, created_at, updated_at) VALUES ('public-ledger-seed-development-cost', 'expense', '2026-06-30', '开发成本', 300.00, '2026-06-30 12:57:53.401681+00', '2026-06-30 12:57:53.401681+00');

INSERT INTO public.recharge_payment_config (id, enabled, epay_url_prefix, epay_platform_id, epay_merchant_private_key, epay_platform_public_key, epay_merchant_key, notify_url, return_url, updated_at, min_coins, max_coins) VALUES ('default', false, '', NULL, '', '', '', '', '', '2026-06-30 12:57:53.126536+00', 1.00, 1000.00);

INSERT INTO public.runtime_config (id, agent_concurrency_limit, updated_at, local_agent_max_processes, local_agent_idle_ttl_ms, pi_session_health_enabled, pi_session_inactive_cleanup_days, pi_session_orphan_grace_days, skill_bundle_max_files, skill_bundle_max_file_chars, skill_bundle_max_total_chars, skill_bundle_max_zip_bytes, default_official_model_id, default_thinking_level, user_skill_max_count) VALUES ('default', 10, '2026-06-30 12:57:53.422822+00', 4, 600000, false, 30, 30, 50, 100000, 500000, 8388608, NULL, 'medium', 30);

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_slug_key UNIQUE (slug);

ALTER TABLE ONLY public.balance_grants
    ADD CONSTRAINT balance_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.bazi_cases
    ADD CONSTRAINT bazi_cases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.billing_request_reservations
    ADD CONSTRAINT billing_request_reservations_pkey PRIMARY KEY (request_id);

ALTER TABLE ONLY public.chat_sessions
    ADD CONSTRAINT chat_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.client_follow_ups
    ADD CONSTRAINT client_follow_ups_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.client_profiles
    ADD CONSTRAINT client_profiles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.config_audit_logs
    ADD CONSTRAINT config_audit_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.conversation_log_payloads
    ADD CONSTRAINT conversation_log_payloads_pkey PRIMARY KEY (log_id);

ALTER TABLE ONLY public.conversation_logs
    ADD CONSTRAINT conversation_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.daily_usage
    ADD CONSTRAINT daily_usage_pkey PRIMARY KEY (user_id, date);

ALTER TABLE ONLY public.membership_config
    ADD CONSTRAINT membership_config_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id, account_id);

ALTER TABLE ONLY public.model_billing_config
    ADD CONSTRAINT model_billing_config_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.monthly_billing_state
    ADD CONSTRAINT monthly_billing_state_pkey PRIMARY KEY (user_id, year_month);

ALTER TABLE ONLY public.official_model_configs
    ADD CONSTRAINT official_model_configs_model_key_key UNIQUE (model_key);

ALTER TABLE ONLY public.official_model_configs
    ADD CONSTRAINT official_model_configs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.open_sessions
    ADD CONSTRAINT open_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.open_sessions
    ADD CONSTRAINT open_sessions_runtime_session_id_key UNIQUE (runtime_session_id);

ALTER TABLE ONLY public.pi_session_cleanup_cursors
    ADD CONSTRAINT pi_session_cleanup_cursors_pkey PRIMARY KEY (mode);

ALTER TABLE ONLY public.public_financial_ledger_entries
    ADD CONSTRAINT public_financial_ledger_entries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.recharge_orders
    ADD CONSTRAINT recharge_orders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.recharge_orders
    ADD CONSTRAINT recharge_orders_trade_id_key UNIQUE (trade_id);

ALTER TABLE ONLY public.recharge_payment_config
    ADD CONSTRAINT recharge_payment_config_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.runtime_config
    ADD CONSTRAINT runtime_config_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.skill_access_invites
    ADD CONSTRAINT skill_access_invites_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.skill_access_invites
    ADD CONSTRAINT skill_access_invites_token_key UNIQUE (token);

ALTER TABLE ONLY public.skill_bundle_items
    ADD CONSTRAINT skill_bundle_items_pkey PRIMARY KEY (bundle_id, skill_id);

ALTER TABLE ONLY public.skill_bundles
    ADD CONSTRAINT skill_bundles_bundle_token_key UNIQUE (bundle_token);

ALTER TABLE ONLY public.skill_bundles
    ADD CONSTRAINT skill_bundles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.skill_comments
    ADD CONSTRAINT skill_comments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.skill_global_config
    ADD CONSTRAINT skill_global_config_pkey PRIMARY KEY (skill_name);

ALTER TABLE ONLY public.system_secrets
    ADD CONSTRAINT system_secrets_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.user_api_keys
    ADD CONSTRAINT user_api_keys_key_hash_key UNIQUE (key_hash);

ALTER TABLE ONLY public.user_api_keys
    ADD CONSTRAINT user_api_keys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_custom_skills
    ADD CONSTRAINT user_custom_skills_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_custom_skills
    ADD CONSTRAINT user_custom_skills_share_token_key UNIQUE (share_token);

ALTER TABLE ONLY public.user_memberships
    ADD CONSTRAINT user_memberships_pkey PRIMARY KEY (user_id, plan_key);

ALTER TABLE ONLY public.user_model_configs
    ADD CONSTRAINT user_model_configs_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY public.user_model_selections
    ADD CONSTRAINT user_model_selections_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY public.user_oauth_identities
    ADD CONSTRAINT user_oauth_identities_pkey PRIMARY KEY (provider, provider_user_id);

ALTER TABLE ONLY public.user_skill_subscription_bundle_sources
    ADD CONSTRAINT user_skill_subscription_bundle_sources_pkey PRIMARY KEY (subscription_id, bundle_id);

ALTER TABLE ONLY public.user_skill_subscriptions
    ADD CONSTRAINT user_skill_subscriptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_skill_subscriptions
    ADD CONSTRAINT user_skill_subscriptions_subscriber_id_skill_id_key UNIQUE (subscriber_id, skill_id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.wallet_transactions
    ADD CONSTRAINT wallet_transactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.wechat_chat_session_links
    ADD CONSTRAINT wechat_chat_session_links_pkey PRIMARY KEY (account_id, sender_hash);

CREATE INDEX idx_announcements_published_at ON public.announcements USING btree (published_at DESC, updated_at DESC);

CREATE INDEX idx_announcements_status_window_priority ON public.announcements USING btree (status, priority DESC, published_at DESC, updated_at DESC);

CREATE INDEX idx_announcements_updated_at ON public.announcements USING btree (updated_at DESC, created_at DESC);

CREATE INDEX idx_balance_grants_expiry_scan ON public.balance_grants USING btree (expires_at) WHERE ((status = 'active'::text) AND (expires_at IS NOT NULL));

CREATE INDEX idx_balance_grants_user_active ON public.balance_grants USING btree (user_id, expires_at, remaining_coins) WHERE (status = 'active'::text);

CREATE INDEX idx_balance_grants_user_active_expiry_created ON public.balance_grants USING btree (user_id, expires_at, created_at) WHERE ((status = 'active'::text) AND (remaining_coins > (0)::numeric));

CREATE INDEX idx_bazi_cases_current_education ON public.bazi_cases USING btree (current_education);

CREATE INDEX idx_bazi_cases_current_wealth ON public.bazi_cases USING btree (current_wealth);

CREATE INDEX idx_bazi_cases_gender ON public.bazi_cases USING btree (gender);

CREATE INDEX idx_bazi_cases_job_type ON public.bazi_cases USING btree (job_type);

CREATE INDEX idx_bazi_cases_marriage ON public.bazi_cases USING btree (marriage);

CREATE INDEX idx_billing_request_reservations_hold_state ON public.billing_request_reservations USING btree (hold_state, charge_state, updated_at);

CREATE INDEX idx_billing_request_reservations_user_created_at ON public.billing_request_reservations USING btree (user_id, created_at DESC);

CREATE INDEX idx_chat_sessions_account_updated ON public.chat_sessions USING btree (account_id, updated_at DESC) WHERE (deleted_at IS NULL);

CREATE INDEX idx_chat_sessions_deleted_id ON public.chat_sessions USING btree (deleted_at, id) WHERE (deleted_at IS NOT NULL);

CREATE INDEX idx_chat_sessions_inactive_id ON public.chat_sessions USING btree (updated_at, id) WHERE (deleted_at IS NULL);

CREATE UNIQUE INDEX idx_chat_sessions_share_token ON public.chat_sessions USING btree (share_token) WHERE (share_token IS NOT NULL);

CREATE INDEX idx_chat_sessions_user_client ON public.chat_sessions USING btree (user_id, client_id);

CREATE INDEX idx_chat_sessions_user_updated ON public.chat_sessions USING btree (user_id, updated_at DESC) WHERE (deleted_at IS NULL);

CREATE INDEX idx_client_follow_ups_client ON public.client_follow_ups USING btree (client_id, created_at DESC) WHERE (deleted_at IS NULL);

CREATE INDEX idx_client_profiles_user ON public.client_profiles USING btree (user_id) WHERE (deleted_at IS NULL);

CREATE INDEX idx_client_profiles_user_status ON public.client_profiles USING btree (user_id, status) WHERE (deleted_at IS NULL);

CREATE INDEX idx_config_audit_created_at ON public.config_audit_logs USING btree (created_at DESC);

CREATE INDEX idx_conv_logs_account ON public.conversation_logs USING btree (account_id);

CREATE INDEX idx_conv_logs_created ON public.conversation_logs USING btree (created_at);

CREATE INDEX idx_conversation_logs_request_id ON public.conversation_logs USING btree (request_id);

CREATE INDEX idx_messages_account ON public.messages USING btree (account_id);

CREATE INDEX idx_messages_account_deleted_timestamp ON public.messages USING btree (account_id, ((deleted_at IS NOT NULL)), "timestamp" DESC);

CREATE INDEX idx_messages_account_timestamp_active ON public.messages USING btree (account_id, "timestamp" DESC) WHERE ((deleted_at IS NULL) AND (session_id IS NULL));

CREATE INDEX idx_messages_session_deleted_timestamp ON public.messages USING btree (session_id, ((deleted_at IS NOT NULL)), "timestamp" DESC) WHERE (session_id IS NOT NULL);

CREATE INDEX idx_messages_session_id ON public.messages USING btree (session_id) WHERE (session_id IS NOT NULL);

CREATE INDEX idx_messages_session_timestamp_active ON public.messages USING btree (session_id, "timestamp" DESC) WHERE ((deleted_at IS NULL) AND (session_id IS NOT NULL));

CREATE INDEX idx_messages_timestamp ON public.messages USING btree ("timestamp");

CREATE INDEX idx_messages_user_deleted_timestamp ON public.messages USING btree (user_id, ((deleted_at IS NOT NULL)), "timestamp" DESC) WHERE (user_id IS NOT NULL);

CREATE INDEX idx_messages_user_session_timestamp_active ON public.messages USING btree (user_id, session_id, "timestamp" DESC) WHERE ((deleted_at IS NULL) AND (session_id IS NOT NULL));

CREATE INDEX idx_official_model_configs_enabled_priority ON public.official_model_configs USING btree (enabled DESC, priority, updated_at DESC);

CREATE INDEX idx_open_sessions_user_active ON public.open_sessions USING btree (user_id) WHERE (status = 'active'::text);

CREATE INDEX idx_public_financial_ledger_occurred_at ON public.public_financial_ledger_entries USING btree (occurred_at DESC, created_at DESC);

CREATE INDEX idx_recharge_orders_status_created_at ON public.recharge_orders USING btree (status, created_at DESC);

CREATE INDEX idx_recharge_orders_status_paid_at ON public.recharge_orders USING btree (status, paid_at DESC) WHERE (paid_at IS NOT NULL);

CREATE INDEX idx_recharge_orders_user_created_at ON public.recharge_orders USING btree (user_id, created_at DESC);

CREATE INDEX idx_skill_access_invites_creator_target ON public.skill_access_invites USING btree (creator_id, target_type, target_id, created_at DESC);

CREATE INDEX idx_skill_access_invites_token ON public.skill_access_invites USING btree (token);

CREATE UNIQUE INDEX idx_skill_bundle_items_bundle_order ON public.skill_bundle_items USING btree (bundle_id, sort_order);

CREATE INDEX idx_skill_bundle_items_skill ON public.skill_bundle_items USING btree (skill_id);

CREATE INDEX idx_skill_bundles_market_listing ON public.skill_bundles USING btree (stat_skill_count DESC, created_at DESC) WHERE ((deleted_at IS NULL) AND (visibility = 'shared'::text) AND (bundle_token IS NOT NULL) AND (stat_skill_count > 0));

CREATE INDEX idx_skill_bundles_token ON public.skill_bundles USING btree (bundle_token) WHERE (bundle_token IS NOT NULL);

CREATE INDEX idx_skill_bundles_user ON public.skill_bundles USING btree (user_id) WHERE (deleted_at IS NULL);

CREATE INDEX idx_skill_comments_admin_skill ON public.skill_comments USING btree (skill_id, created_at DESC);

CREATE INDEX idx_skill_comments_admin_status ON public.skill_comments USING btree (status, created_at DESC);

CREATE INDEX idx_skill_comments_public ON public.skill_comments USING btree (skill_id, pinned DESC, reviewed_at DESC, created_at DESC) WHERE (status = 'approved'::text);

CREATE INDEX idx_ucs_market_category_listing ON public.user_custom_skills USING btree (category, stat_subscriber_count DESC, created_at DESC) WHERE ((deleted_at IS NULL) AND (visibility = 'shared'::text));

CREATE INDEX idx_ucs_market_listing ON public.user_custom_skills USING btree (stat_subscriber_count DESC, created_at DESC) WHERE ((deleted_at IS NULL) AND (visibility = 'shared'::text));

CREATE INDEX idx_ucs_share_token ON public.user_custom_skills USING btree (share_token);

CREATE INDEX idx_ucs_user ON public.user_custom_skills USING btree (user_id);

CREATE UNIQUE INDEX idx_ucs_user_dir_active ON public.user_custom_skills USING btree (user_id, dir_name) WHERE (deleted_at IS NULL);

CREATE INDEX idx_user_api_keys_user_active ON public.user_api_keys USING btree (user_id) WHERE (status = 'active'::text);

CREATE INDEX idx_user_memberships_active_period ON public.user_memberships USING btree (status, current_period_end);

CREATE INDEX idx_user_memberships_user_effective ON public.user_memberships USING btree (user_id, status, current_period_end DESC);

CREATE INDEX idx_user_model_selections_official_model ON public.user_model_selections USING btree (official_model_id) WHERE (official_model_id IS NOT NULL);

CREATE INDEX idx_user_oauth_identities_email ON public.user_oauth_identities USING btree (lower(email)) WHERE (email IS NOT NULL);

CREATE UNIQUE INDEX idx_user_oauth_identities_user_provider ON public.user_oauth_identities USING btree (user_id, provider);

CREATE INDEX idx_users_created_at ON public.users USING btree (created_at DESC);

CREATE INDEX idx_users_id_trgm ON public.users USING gin (id public.gin_trgm_ops);

CREATE INDEX idx_users_phone_trgm ON public.users USING gin (phone public.gin_trgm_ops);

CREATE UNIQUE INDEX idx_users_phone_unique ON public.users USING btree (phone) WHERE (phone IS NOT NULL);

CREATE INDEX idx_uss_bundle_sources_bundle ON public.user_skill_subscription_bundle_sources USING btree (bundle_id);

CREATE INDEX idx_uss_skill ON public.user_skill_subscriptions USING btree (skill_id);

CREATE INDEX idx_uss_subscriber ON public.user_skill_subscriptions USING btree (subscriber_id);

CREATE INDEX idx_uss_subscriber_enabled_active_expiry ON public.user_skill_subscriptions USING btree (subscriber_id, expires_at) WHERE ((enabled = true) AND (status = 'active'::text));

CREATE INDEX idx_wallet_transactions_created_at ON public.wallet_transactions USING btree (created_at DESC);

CREATE INDEX idx_wallet_transactions_kind_created_at ON public.wallet_transactions USING btree (kind, created_at DESC);

CREATE INDEX idx_wallet_transactions_user_created_at ON public.wallet_transactions USING btree (user_id, created_at DESC);

CREATE INDEX idx_wechat_session_links_session ON public.wechat_chat_session_links USING btree (session_id);

CREATE INDEX idx_wechat_session_links_user_updated ON public.wechat_chat_session_links USING btree (user_id, updated_at DESC);

CREATE UNIQUE INDEX uq_client_profiles_user_name ON public.client_profiles USING btree (user_id, name) WHERE (deleted_at IS NULL);

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.balance_grants
    ADD CONSTRAINT balance_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.billing_request_reservations
    ADD CONSTRAINT billing_request_reservations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.chat_sessions
    ADD CONSTRAINT chat_sessions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.client_profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.chat_sessions
    ADD CONSTRAINT chat_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.client_follow_ups
    ADD CONSTRAINT client_follow_ups_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.client_profiles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.client_follow_ups
    ADD CONSTRAINT client_follow_ups_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.client_profiles
    ADD CONSTRAINT client_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.conversation_log_payloads
    ADD CONSTRAINT conversation_log_payloads_log_id_fkey FOREIGN KEY (log_id) REFERENCES public.conversation_logs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.daily_usage
    ADD CONSTRAINT daily_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT fk_messages_session_id FOREIGN KEY (session_id) REFERENCES public.chat_sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.runtime_config
    ADD CONSTRAINT fk_runtime_config_default_official_model FOREIGN KEY (default_official_model_id) REFERENCES public.official_model_configs(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.user_custom_skills
    ADD CONSTRAINT fk_user_custom_skills_user_id FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_skill_subscriptions
    ADD CONSTRAINT fk_user_skill_subscriptions_skill_id FOREIGN KEY (skill_id) REFERENCES public.user_custom_skills(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_skill_subscriptions
    ADD CONSTRAINT fk_user_skill_subscriptions_subscriber_id FOREIGN KEY (subscriber_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.monthly_billing_state
    ADD CONSTRAINT monthly_billing_state_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.open_sessions
    ADD CONSTRAINT open_sessions_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES public.user_api_keys(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.open_sessions
    ADD CONSTRAINT open_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.recharge_orders
    ADD CONSTRAINT recharge_orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.skill_access_invites
    ADD CONSTRAINT skill_access_invites_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.skill_bundle_items
    ADD CONSTRAINT skill_bundle_items_bundle_id_fkey FOREIGN KEY (bundle_id) REFERENCES public.skill_bundles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.skill_bundle_items
    ADD CONSTRAINT skill_bundle_items_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES public.user_custom_skills(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.skill_bundles
    ADD CONSTRAINT skill_bundles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.skill_comments
    ADD CONSTRAINT skill_comments_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES public.user_custom_skills(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.skill_comments
    ADD CONSTRAINT skill_comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_api_keys
    ADD CONSTRAINT user_api_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_memberships
    ADD CONSTRAINT user_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_model_configs
    ADD CONSTRAINT user_model_configs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_model_selections
    ADD CONSTRAINT user_model_selections_official_model_id_fkey FOREIGN KEY (official_model_id) REFERENCES public.official_model_configs(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.user_model_selections
    ADD CONSTRAINT user_model_selections_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_oauth_identities
    ADD CONSTRAINT user_oauth_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_skill_subscription_bundle_sources
    ADD CONSTRAINT user_skill_subscription_bundle_sources_bundle_id_fkey FOREIGN KEY (bundle_id) REFERENCES public.skill_bundles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_skill_subscription_bundle_sources
    ADD CONSTRAINT user_skill_subscription_bundle_sources_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.user_skill_subscriptions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.wallet_transactions
    ADD CONSTRAINT wallet_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.wechat_chat_session_links
    ADD CONSTRAINT wechat_chat_session_links_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.wechat_chat_session_links
    ADD CONSTRAINT wechat_chat_session_links_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.chat_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.wechat_chat_session_links
    ADD CONSTRAINT wechat_chat_session_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
`;

export const baselineMigrations: DatabaseMigration[] = [
  {
    id: "0001_core_schema_baseline",
    description: "全量基线 schema（压平历史 0001-0067 迁移）",
    up: async (client: pg.PoolClient): Promise<void> => {
      await client.query(BASELINE_SQL);
    },
  },
];
