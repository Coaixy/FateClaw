import { describe, expect, it } from 'vitest';

import { runDatabaseMigrations } from '../../src/infrastructure/migrations.js';

interface QueryCall {
  sql: string;
  params?: unknown[];
}

function createMockClient(appliedIds: string[] = []) {
  const calls: QueryCall[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql === 'SELECT id FROM schema_migrations') {
        return { rows: appliedIds.map((id) => ({ id })) };
      }
      return { rows: [] };
    },
  };

  return { client, calls };
}

describe('runDatabaseMigrations', () => {
  it('creates the migration ledger and records unapplied migrations', async () => {
    const { client, calls } = createMockClient();

    await runDatabaseMigrations(client as never);

    expect(calls[0]?.sql).toBe('SELECT pg_advisory_lock($1, $2)');
    expect(calls[1]?.sql).toContain(
      'CREATE TABLE IF NOT EXISTS schema_migrations',
    );
    expect(
      calls.some((call) =>
        call.sql.includes('CREATE TABLE IF NOT EXISTS users'),
      ),
    ).toBe(true);
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0001_core_schema_baseline',
        '创建历史 init-pg.sql 承载的核心基础表',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0002_config_and_model_schema',
        '迁移系统密钥、模型配置与配置审计 schema',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0004_phone_only_user_schema',
        '迁移用户表到手机号唯一登录 schema',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0005_model_pi_api_schema',
        '迁移模型配置 provider 字段到 Pi API schema',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0006_remove_user_system_skill_preferences',
        '移除用户级系统排盘开关和默认启用配置',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: ['0008_balance_cents_schema', '将历史 point 列按分余额语义保留'],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0009_remove_creator_earnings_schema',
        '移除创作收益与提现 schema',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0010_daily_sign_in_reward_config',
        '增加每日签到软妹币奖励配置和签到记录',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0011_soft_currency_coins_schema',
        '迁移余额与充值 schema 到软妹币整数单位',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: ['0012_model_billing_config', '增加模型平台服务费配置'],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0013_soft_currency_decimal_scale',
        '软妹币金额字段支持两位小数',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0014_daily_usage_total_tokens',
        '为每日用量增加 Pi total token 统计列',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0016_remove_skill_paid_schema',
        '移除 Skill 付费档位与创作者整包付费 schema',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0017_membership_token_plan',
        '增加 FateClaw Plus 会员与月度额度 schema',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0018_chat_session_archive_and_share',
        '增加 AI Chat 会话分享与 Pi session 数据库归档 schema',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: ['0019_user_soul_edit_enabled', '增加用户级 Soul 对话编辑开关'],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0025_local_agent_runtime_limits',
        '增加本地 agent-runtime 常驻进程上限与空闲回收配置',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0027_user_auth_token_version',
        '增加用户认证 token 版本以支持改密后旧 JWT 失效',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0028_skill_bundle_runtime_limits',
        '增加用户 Skill Bundle 文件限制后台配置',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0029_simple_workflow_presets',
        '增加简易模式 Workflow preset 配置',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0031_default_official_model_runtime_config',
        '增加后台系统默认官方模型配置',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0032_default_thinking_level_runtime_config',
        '增加后台默认思考等级配置',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0033_referral_invite_count_reward',
        '增加累计邀请人数会员奖励配置',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: ['0034_announcements', '增加运营公告系统 schema'],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0035_simple_workflow_skill_snapshots',
        '为简易模式 Workflow 增加绑定 Skill 快照',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0036_repair_simple_workflow_skill_snapshot_columns',
        '修复简易模式 Workflow Skill 快照列缺失',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: ['0037_membership_pro_plan', '增加 FateClaw Pro 会员套餐配置'],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0038_membership_plan_timeline',
        '允许同一用户同时持有不同档位会员权益',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0039_free_professional_ai_quota',
        '增加 Free 用户专业模式 AI 每日次数配置和用量表',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: ['0040_billing_gift_codes', '增加软妹币礼品码和兑换记录'],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0041_oauth_user_identities',
        '增加第三方登录身份并允许用户无手机号注册',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0043_repair_legacy_pro_to_deep_memberships',
        '修复旧 Pro 会员迁移后被低档 Insight 覆盖的问题',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0044_referral_reward_membership_plan',
        '允许后台配置邀请奖励会员档位',
      ],
    });
    expect(
      calls.some((call) =>
        call.sql.includes('reward_membership_plan_key TEXT NOT NULL DEFAULT'),
      ),
    ).toBe(true);
    expect(
      calls.some((call) => call.sql.includes('membership-repair-deep-')),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.sql.includes('INSERT INTO user_memberships') &&
          call.sql.includes(
            "metadata->>'planKey' IN ('fateclaw_pro', 'fateclaw_deep')",
          ) &&
          call.sql.includes("'fateclaw_deep'"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.sql.includes('INSERT INTO membership_allowances') &&
          call.sql.includes('membership-repair-deep-') &&
          call.sql.includes('ON CONFLICT (user_id, plan_key, period_start)'),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.sql.includes("l.usage->>'totalTokens'") &&
          call.sql.includes('GREATEST('),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.sql.includes('CREATE TABLE IF NOT EXISTS official_model_configs'),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.sql.includes('CREATE TABLE IF NOT EXISTS daily_sign_in_config'),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.sql.includes('CREATE TABLE IF NOT EXISTS model_billing_config'),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.sql.includes('CREATE TABLE IF NOT EXISTS membership_config'),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.sql.includes('chk_official_model_configs_pi_api_valid'),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.sql.includes(
          'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique',
        ),
      ),
    ).toBe(true);
    expect(calls.some((call) => call.sql.includes('soul_edit_enabled'))).toBe(
      true,
    );
    expect(calls.some((call) => call.sql.includes('thinking_level'))).toBe(
      true,
    );
    expect(
      calls.some((call) => call.sql.includes('local_agent_max_processes')),
    ).toBe(true);
    expect(
      calls.some((call) => call.sql.includes('local_agent_idle_ttl_ms')),
    ).toBe(true);
    expect(
      calls.some((call) => call.sql.includes('pi_session_health_enabled')),
    ).toBe(true);
    expect(calls.some((call) => call.sql.includes('auth_token_version'))).toBe(
      true,
    );
    expect(
      calls.some((call) =>
        call.sql.includes('CREATE TABLE IF NOT EXISTS simple_workflow_presets'),
      ),
    ).toBe(true);
    expect(
      calls.some((call) => call.sql.includes('invite_count_reward_threshold')),
    ).toBe(true);
    expect(
      calls.some((call) => call.sql.includes('skill_bundle_max_files')),
    ).toBe(true);
    expect(
      calls.some((call) => call.sql.includes('user_skill_max_count')),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.sql.includes('CREATE TABLE IF NOT EXISTS announcements'),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.sql.includes('chk_announcements_cta_href_safe'),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.sql.includes(
          'chk_runtime_config_skill_bundle_total_chars_at_least_file_chars',
        ),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.sql.includes('chk_runtime_config_user_skill_max_count_range'),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.sql.includes(
          'chk_runtime_config_pi_session_inactive_cleanup_days_range',
        ),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.sql.includes('chk_runtime_config_local_agent_max_processes_range'),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.sql.includes('CREATE TABLE IF NOT EXISTS user_oauth_identities'),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.sql.includes('ALTER COLUMN password_hash DROP NOT NULL'),
      ),
    ).toBe(true);
    // 0046：公开 Skill 赞踩与匿名评论审核表
    expect(
      calls.some((call) =>
        call.sql.includes('CREATE TABLE IF NOT EXISTS skill_reactions'),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.sql.includes('chk_skill_reactions_kind_valid'),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.sql.includes('CREATE TABLE IF NOT EXISTS skill_comments'),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.sql.includes('chk_skill_comments_status_valid'),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.sql.includes('chk_skill_comments_body_length'),
      ),
    ).toBe(true);
    expect(calls.some((call) => call.sql === 'BEGIN')).toBe(true);
    expect(calls.some((call) => call.sql === 'COMMIT')).toBe(true);
    expect(calls.at(-1)?.sql).toBe('SELECT pg_advisory_unlock($1, $2)');
  });

  it('skips migrations already recorded in the ledger', async () => {
    const { client, calls } = createMockClient([
      '0001_core_schema_baseline',
      '0002_config_and_model_schema',
      '0003_application_schema_expansion',
      '0004_phone_only_user_schema',
      '0005_model_pi_api_schema',
      '0006_remove_user_system_skill_preferences',
      '0007_user_soul_content',
      '0008_balance_cents_schema',
      '0009_remove_creator_earnings_schema',
      '0010_daily_sign_in_reward_config',
      '0011_soft_currency_coins_schema',
      '0012_model_billing_config',
      '0013_soft_currency_decimal_scale',
      '0014_daily_usage_total_tokens',
      '0015_public_financial_ledger',
      '0016_remove_skill_paid_schema',
      '0017_membership_token_plan',
      '0018_chat_session_archive_and_share',
      '0019_user_soul_edit_enabled',
      '0020_runtime_config',
      '0021_wechat_chat_session_links',
      '0022_drop_scheduled_tasks',
      '0023_skill_access_invites',
      '0024_user_model_thinking_level',
      '0025_local_agent_runtime_limits',
      '0026_pi_session_health_runtime_config',
      '0027_user_auth_token_version',
      '0028_skill_bundle_runtime_limits',
      '0029_simple_workflow_presets',
      '0030_user_referrals',
      '0031_default_official_model_runtime_config',
      '0032_default_thinking_level_runtime_config',
      '0033_referral_invite_count_reward',
      '0034_announcements',
      '0035_simple_workflow_skill_snapshots',
      '0036_repair_simple_workflow_skill_snapshot_columns',
      '0037_membership_pro_plan',
      '0038_membership_plan_timeline',
      '0039_free_professional_ai_quota',
      '0040_billing_gift_codes',
      '0041_oauth_user_identities',
      '0042_membership_tier_rekey',
      '0043_repair_legacy_pro_to_deep_memberships',
      '0044_referral_reward_membership_plan',
      '0045_sql_review_indexes_and_bundle_stats',
      '0046_skill_reactions_and_comments',
      '0047_membership_default_pricing_snapshot',
      '0048_user_skill_runtime_limit',
      '0049_collapse_membership_to_guashi_access',
      '0050_client_profiles',
      '0051_user_guashi_script_template',
      '0052_disable_legacy_plus_pro_membership_plans',
      '0053_clarity_no_free_allowance',
      '0054_migrate_legacy_active_members_to_clarity',
      '0055_allowance_units_nonnegative',
      '0056_referral_reward_clarity_only',
      '0057_disable_wechat_claw_accounts',
      '0058_normalize_all_plan_keys_to_clarity',
      '0059_drop_allowance_columns_and_table',
      '0060_client_crm_fields',
      '0061_client_follow_ups',
    ]);

    await runDatabaseMigrations(client as never);

    expect(
      calls.some((call) =>
        call.sql.includes('CREATE TABLE IF NOT EXISTS users'),
      ),
    ).toBe(false);
    expect(
      calls.some((call) => call.sql.includes('INSERT INTO schema_migrations')),
    ).toBe(false);
    expect(calls.some((call) => call.sql === 'BEGIN')).toBe(false);
    expect(calls.at(-1)?.sql).toBe('SELECT pg_advisory_unlock($1, $2)');
  });
});
