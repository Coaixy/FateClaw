import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/infrastructure/migrations/definitions.js';
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
  it('creates the migration ledger and applies the squashed baseline', async () => {
    const { client, calls } = createMockClient();

    await runDatabaseMigrations(client as never);

    // 加锁 → 建账本 → 查已应用
    expect(calls[0]?.sql).toBe('SELECT pg_advisory_lock($1, $2)');
    expect(calls[1]?.sql).toContain(
      'CREATE TABLE IF NOT EXISTS schema_migrations',
    );

    // 基线在单条事务内执行，整段 schema 通过一次 query 落库
    expect(calls.some((call) => call.sql === 'BEGIN')).toBe(true);
    expect(calls.some((call) => call.sql === 'COMMIT')).toBe(true);
    const baselineSql = calls.find((call) =>
      call.sql.includes('CREATE TABLE public.users'),
    )?.sql;
    expect(baselineSql).toBeDefined();
    // 抽样核对基线覆盖到关键表与默认配置种子
    expect(baselineSql).toContain('CREATE TABLE public.runtime_config');
    expect(baselineSql).toContain('CREATE TABLE public.membership_config');
    expect(baselineSql).toContain('CREATE TABLE public.announcements');
    expect(baselineSql).toContain('INSERT INTO public.runtime_config');

    // 基线以历史首条 id 记账，确保已存在的库会跳过
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0001_core_schema_baseline',
        '全量基线 schema（压平历史 0001-0067 迁移）',
      ],
    });

    expect(calls.at(-1)?.sql).toBe('SELECT pg_advisory_unlock($1, $2)');
  });

  it('skips migrations already recorded in the ledger', async () => {
    const { client, calls } = createMockClient(
      MIGRATIONS.map((migration) => migration.id),
    );

    await runDatabaseMigrations(client as never);

    expect(
      calls.some((call) => call.sql.includes('CREATE TABLE public.users')),
    ).toBe(false);
    expect(
      calls.some((call) => call.sql.includes('INSERT INTO schema_migrations')),
    ).toBe(false);
    expect(calls.some((call) => call.sql === 'BEGIN')).toBe(false);
    expect(calls.at(-1)?.sql).toBe('SELECT pg_advisory_unlock($1, $2)');
  });

  it('runs the invalid-phone cleanup once as migration 0071 when unrecorded', async () => {
    // 回归防护：无效手机号用户清理已从「每次启动无条件跑」改为受账本管理的一次性迁移。
    // 未记录 0071 时应执行清理（建删除集临时表）并以 0071 记账；已记录则被上一个用例覆盖。
    const { client, calls } = createMockClient([
      '0001_core_schema_baseline',
      '0070_agent_runtime_and_billing_perf',
    ]);

    await runDatabaseMigrations(client as never);

    expect(
      calls.some((call) =>
        call.sql.includes('CREATE TEMP TABLE users_without_valid_phone'),
      ),
    ).toBe(true);
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0071_cleanup_invalid_phone_users',
        '一次性清理无有效手机号的历史脏用户及其关联数据',
      ],
    });
  });

  it('drops dead feature tables once as migration 0073 when unrecorded', async () => {
    // 回归防护：simpleWorkflow 预置表与 ai_chat 免费/专业额度三表已无任何代码接线，
    // 由一次性迁移 0073 在存量库上 DROP（全新库基线已不再建出这些表，届时为 no-op）。
    const { client, calls } = createMockClient([
      '0001_core_schema_baseline',
      '0070_agent_runtime_and_billing_perf',
      '0071_cleanup_invalid_phone_users',
      '0072_purge_orphan_bundle_subscriptions',
    ]);

    await runDatabaseMigrations(client as never);

    for (const table of [
      'simple_workflow_presets',
      'ai_chat_free_daily_usage',
      'ai_chat_free_quota_config',
      'ai_chat_professional_daily_usage',
    ]) {
      expect(
        calls.some(
          (call) => call.sql === `DROP TABLE IF EXISTS public.${table}`,
        ),
      ).toBe(true);
    }
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0073_drop_dead_feature_tables',
        '删除死功能表：simple_workflow_presets 与 ai_chat 免费/专业额度三表',
      ],
    });
  });

  it('drops removed feature tables once as migration 0074 when unrecorded', async () => {
    // 回归防护：礼品码/邀请返利/每日签到/技能点赞四组功能已删除，其残留的 9 张表
    // 由一次性迁移 0074 在存量库上按外键依赖顺序 DROP（全新库基线已不再建出这些表）。
    const { client, calls } = createMockClient([
      '0001_core_schema_baseline',
      '0070_agent_runtime_and_billing_perf',
      '0071_cleanup_invalid_phone_users',
      '0072_purge_orphan_bundle_subscriptions',
      '0073_drop_dead_feature_tables',
    ]);

    await runDatabaseMigrations(client as never);

    const dropOrder = [
      'gift_code_redemptions',
      'gift_codes',
      'referral_reward_events',
      'user_referrals',
      'user_invite_codes',
      'referral_config',
      'daily_sign_in_records',
      'daily_sign_in_config',
      'skill_reactions',
    ];
    // 逐表确认 DROP 语句存在，且子表先于其父表执行（外键依赖顺序）
    const dropIndexes = dropOrder.map((table) =>
      calls.findIndex(
        (call) => call.sql === `DROP TABLE IF EXISTS public.${table}`,
      ),
    );
    for (const index of dropIndexes) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(dropIndexes).toEqual([...dropIndexes].sort((a, b) => a - b));
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0074_drop_removed_feature_tables',
        '删除已删功能残留表：礼品码/邀请返利/每日签到/技能点赞 共 9 张',
      ],
    });
  });

  it('purges orphan bundle subscriptions once as migration 0072 when unrecorded', async () => {
    // 回归防护：历史失效 bundle（删除/取消分享/下架/移出 skill）遗留的孤儿订阅回收，
    // 作为一次性迁移 0072 执行（删死来源行）并以 0072 记账。
    const { client, calls } = createMockClient([
      '0001_core_schema_baseline',
      '0070_agent_runtime_and_billing_perf',
      '0071_cleanup_invalid_phone_users',
    ]);

    await runDatabaseMigrations(client as never);

    expect(
      calls.some((call) =>
        call.sql.includes('DELETE FROM user_skill_subscription_bundle_sources'),
      ),
    ).toBe(true);
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0072_purge_orphan_bundle_subscriptions',
        '一次性回收历史失效 bundle（删除/取消分享/下架/移出 skill）遗留的孤儿订阅',
      ],
    });
  });
});
