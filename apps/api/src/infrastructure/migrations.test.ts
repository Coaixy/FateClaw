import { describe, expect, it } from 'vitest';

import { runDatabaseMigrations } from './migrations.js';

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
      calls.some((call) => call.sql.includes('skill_bundle_max_files')),
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
